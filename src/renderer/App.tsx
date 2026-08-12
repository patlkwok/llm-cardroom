import { useCallback, useEffect, useRef, useState } from 'react'
import {
  defaultSettings,
  GAMES,
  type DecisionRecord,
  type KeyStorageKind,
  type LogEntry,
  type MatchSettings,
  type MatchSnapshot,
  type ModelInfo,
  type PlayerConfig
} from '../shared/types.ts'
import { SetupPanel } from './components/SetupPanel.tsx'
import { ModelPicker } from './components/ModelPicker.tsx'
import { BlackjackView } from './components/BlackjackView.tsx'
import { PokerView } from './components/PokerView.tsx'
import { FeedPanel } from './components/FeedPanel.tsx'

const MAX_LOG = 600
const MAX_DECISIONS = 250

export interface KeyCheck {
  state: 'unknown' | 'checking' | 'ok' | 'bad'
  detail: string
}

/** Turns "Anthropic: Claude Sonnet 4.5" into "Claude Sonnet 4.5". */
function shortModelName(model: ModelInfo): string {
  const withoutVendor = model.name.includes(':') ? model.name.split(':').slice(1).join(':') : model.name
  return withoutVendor.trim().slice(0, 22) || model.id
}

function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base
  for (let n = 2; n < 50; n++) {
    const candidate = `${base} ${n}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${base} ${Date.now() % 1000}`
}

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<MatchSettings>(defaultSettings())
  const [hasApiKey, setHasApiKey] = useState(false)
  const [keyCheck, setKeyCheck] = useState<KeyCheck>({ state: 'unknown', detail: '' })
  const [keyStorage, setKeyStorage] = useState<KeyStorageKind>('os-keychain')
  const [snapshot, setSnapshot] = useState<MatchSnapshot | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  const [decisions, setDecisions] = useState<DecisionRecord[]>([])
  const [thinking, setThinking] = useState<Record<string, boolean>>({})
  const [pickerFor, setPickerFor] = useState<'new' | string | null>(null)
  const [toast, setToast] = useState('')
  const [loaded, setLoaded] = useState(false)

  const settingsRef = useRef(settings)
  settingsRef.current = settings

  useEffect(() => {
    void (async () => {
      const config = await window.cardroom.getConfig()
      setSettings(config.settings)
      setHasApiKey(config.hasApiKey)
      setKeyStorage(config.keyStorage)
      setLoaded(true)

      // A saved key is not necessarily a working key: check it up front rather
      // than letting every decision fail once play starts.
      if (config.hasApiKey) {
        setKeyCheck({ state: 'checking', detail: '' })
        const result = await window.cardroom.verifyApiKey()
        setKeyCheck({ state: result.ok ? 'ok' : 'bad', detail: result.detail })
      }
    })()
  }, [])

  useEffect(() => {
    return window.cardroom.onMatchEvent((event) => {
      if (event.type === 'snapshot') {
        setSnapshot(event.snapshot)
      } else if (event.type === 'log') {
        setLog((prev) => [...prev, event.entry].slice(-MAX_LOG))
      } else if (event.type === 'decision') {
        setDecisions((prev) => [...prev, event.record].slice(-MAX_DECISIONS))
      } else if (event.type === 'thinking') {
        setThinking((prev) => ({ ...prev, [event.playerId]: event.active }))
      }
    })
  }, [])

  const status = snapshot?.status ?? 'idle'
  const isLive = status === 'running' || status === 'paused'

  // Table setup is never written to disk — each launch starts fresh. While a
  // match is live, edits are pushed to the runner, which picks up the ones it
  // can safely change between hands.
  useEffect(() => {
    if (!loaded || !isLive) return
    const timer = setTimeout(() => {
      void window.cardroom.updateLiveSettings(settingsRef.current)
    }, 300)
    return () => clearTimeout(timer)
  }, [settings, loaded, isLive])

  const showToast = useCallback((text: string) => {
    setToast(text)
    setTimeout(() => setToast(''), 5000)
  }, [])

  function handlePick(model: ModelInfo): void {
    setSettings((prev) => {
      if (pickerFor === 'new') {
        const taken = prev.players.map((p) => p.name)
        const player: PlayerConfig = {
          id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          name: uniqueName(shortModelName(model), taken),
          modelId: model.id,
          modelName: model.name,
          reasoningEffort: 'default'
        }
        return { ...prev, players: [...prev.players, player] }
      }
      return {
        ...prev,
        players: prev.players.map((p) =>
          p.id === pickerFor
            ? { ...p, modelId: model.id, modelName: model.name }
            : p
        )
      }
    })
    setPickerFor(null)
  }

  async function handleStart(): Promise<void> {
    setLog([])
    setDecisions([])
    setThinking({})
    setSnapshot(null)
    try {
      await window.cardroom.startMatch(settings)
    } catch (error) {
      const message = (error as Error).message.replace(
        /^Error invoking remote method '[^']+':\s*(Error:\s*)?/,
        ''
      )
      showToast(message)
    }
  }

  // Seats arrive at a round boundary in both games, so a just-added model is
  // not yet seated and its setup stays editable until it is dealt in.
  const seatedPlayerIds =
    settings.game === 'poker'
      ? (snapshot?.poker?.seats.map((seat) => seat.id) ?? [])
      : (snapshot?.blackjack?.players.map((player) => player.id) ?? [])

  const activePlayers = settings.players

  return (
    <div className="app">
      <SetupPanel
        settings={settings}
        onChange={setSettings}
        status={status}
        hasApiKey={hasApiKey}
        keyCheck={keyCheck}
        keyStorage={keyStorage}
        seatedPlayerIds={seatedPlayerIds}
        onSaveApiKey={async (key) => {
          const result = await window.cardroom.setApiKey(key)
          setHasApiKey(result.hasApiKey)
          setKeyCheck({ state: 'ok', detail: 'Checked just now.' })
        }}
        onVerifyApiKey={(key) => window.cardroom.verifyApiKey(key)}
        onAddPlayer={() => setPickerFor('new')}
        onReplacePlayer={(playerId) => setPickerFor(playerId)}
        onRemovePlayer={(playerId) =>
          setSettings((prev) => ({
            ...prev,
            players: prev.players.filter((p) => p.id !== playerId)
          }))
        }
        onStart={() => void handleStart()}
        onPause={() => void window.cardroom.pauseMatch()}
        onResume={() => void window.cardroom.resumeMatch()}
        onStop={() => void window.cardroom.stopMatch()}
      />

      <main className="stage">
        <StatusBar status={status} snapshot={snapshot} settings={settings} />

        <div className="table-wrap">
          {settings.game === 'blackjack' ? (
            <BlackjackView
              state={snapshot?.blackjack ?? emptyBlackjackState(settings)}
              thinking={thinking}
              rules={settings.blackjack}
            />
          ) : (
            <PokerView
              state={snapshot?.poker ?? emptyPokerState(settings)}
              thinking={thinking}
            />
          )}
        </div>
      </main>

      <FeedPanel decisions={decisions} log={log} snapshot={snapshot} players={activePlayers} />

      <ModelPicker
        open={pickerFor !== null}
        title={pickerFor === 'new' ? 'Seat a model' : 'Change model'}
        onPick={handlePick}
        onClose={() => setPickerFor(null)}
      />

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function StatusBar({
  status,
  snapshot,
  settings
}: {
  status: string
  snapshot: MatchSnapshot | null
  settings: MatchSettings
}): React.JSX.Element {
  const label: Record<string, string> = {
    idle: 'Ready',
    running: 'Playing',
    paused: 'Paused',
    stopping: 'Stopping',
    finished: 'Finished',
    error: 'Error'
  }
  const cost = snapshot?.stats.reduce((sum, s) => sum + s.costUsd, 0) ?? 0
  const number =
    settings.game === 'blackjack'
      ? (snapshot?.blackjack?.roundNumber ?? 0)
      : (snapshot?.poker?.handNumber ?? 0)
  const game = GAMES[settings.game]
  const counter = `${game.roundNoun.replace(/^./, (c) => c.toUpperCase())} ${number}`

  return (
    <header className="statusbar">
      <span className={`status-pill status-${status}`}>{label[status] ?? status}</span>
      <span className="status-game">{game.label}</span>
      <span className="status-counter">{counter}</span>
      {cost > 0 && <span className="status-cost">${cost.toFixed(4)} spent</span>}
      {snapshot?.errorText && <span className="status-error">{snapshot.errorText}</span>}
    </header>
  )
}

function emptyBlackjackState(settings: MatchSettings): NonNullable<MatchSnapshot['blackjack']> {
  return {
    phase: 'idle',
    roundNumber: 0,
    baseBet: settings.blackjack.baseBet,
    shoeRemaining: settings.blackjack.deckCount * 52,
    shoeJustShuffled: false,
    players: settings.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      modelId: player.modelId,
      seatIndex: index,
      bankroll: settings.blackjack.startingBankroll,
      hands: [],
      activeHandIndex: 0,
      insuranceOffer: 0,
      insuranceBet: 0,
      sessionNet: 0,
      lastRoundNet: 0,
      roundsPlayed: 0,
      handsWon: 0,
      handsLost: 0,
      handsPushed: 0,
      blackjacks: 0,
      busts: 0,
      busted: false
    })),
    activePlayerIndex: -1,
    dealerCards: [],
    dealerHoleHidden: true,
    insuranceOffered: false,
    roundsPlayed: 0
  }
}

function emptyPokerState(settings: MatchSettings): NonNullable<MatchSnapshot['poker']> {
  return {
    phase: 'idle',
    handNumber: 0,
    street: 'preflop',
    board: [],
    seats: settings.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      modelId: player.modelId,
      seatIndex: index,
      stack: settings.poker.startingStack,
      cards: [],
      cardsRevealed: false,
      folded: false,
      allIn: false,
      committed: 0,
      totalCommitted: 0,
      busted: false,
      wonThisHand: 0
    })),
    buttonIndex: 0,
    actingSeatIndex: -1,
    pot: 0,
    currentBet: 0,
    minRaiseIncrement: settings.poker.bigBlind,
    smallBlind: settings.poker.smallBlind,
    bigBlind: settings.poker.bigBlind,
    sidePots: [],
    handsPlayed: 0
  }
}
