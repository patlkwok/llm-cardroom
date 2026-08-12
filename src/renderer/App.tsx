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
import { GAME_VIEWS, roundNumberOf, seatedIdsOf } from './components/gameViews.tsx'
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

  // Seats arrive at a round boundary, so a just-added model is not yet seated
  // and its setup stays editable until it is dealt in.
  const seatedPlayerIds = seatedIdsOf(snapshot?.table)
  const activePlayers = settings.players
  const GameView = GAME_VIEWS[settings.game]

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
          {GameView ? (
            <GameView snapshot={snapshot} settings={settings} thinking={thinking} />
          ) : (
            <div className="felt">
              <div className="empty-hand">{GAMES[settings.game].label} is not playable yet.</div>
            </div>
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
  const number = roundNumberOf(snapshot?.table)
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
