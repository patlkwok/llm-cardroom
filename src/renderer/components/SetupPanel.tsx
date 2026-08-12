import { useState } from 'react'
import type { KeyCheck } from '../App.tsx'
import {
  REASONING_EFFORTS,
  type GameKind,
  type KeyStorageKind,
  type MatchSettings,
  type MatchStatus,
  type PlayerConfig,
  type ReasoningEffort
} from '../../shared/types.ts'

interface Props {
  settings: MatchSettings
  onChange: (settings: MatchSettings) => void
  status: MatchStatus
  hasApiKey: boolean
  keyCheck: KeyCheck
  keyStorage: KeyStorageKind
  /** Players already dealt in; their setup is fixed for the rest of the match. */
  seatedPlayerIds: string[]
  onSaveApiKey: (key: string) => Promise<void>
  onVerifyApiKey: (key: string) => Promise<{ ok: boolean; detail: string }>
  onAddPlayer: () => void
  onReplacePlayer: (playerId: string) => void
  onRemovePlayer: (playerId: string) => void
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
}

const MAX_PLAYERS: Record<GameKind, number> = { blackjack: 1, poker: 8 }

export function SetupPanel(props: Props): React.JSX.Element {
  const { settings, onChange, status, hasApiKey } = props
  const running = status === 'running' || status === 'paused' || status === 'stopping'
  const locked = running
  // Poker seats can come and go between hands; a blackjack seat cannot.
  const rosterLocked = running && settings.game !== 'poker'

  const players = settings.players
  const maxPlayers = MAX_PLAYERS[settings.game]
  const minPlayers = settings.game === 'poker' ? 2 : 1

  const readyText = describeReadiness(settings, hasApiKey, minPlayers, maxPlayers, props.keyCheck)

  function patch(partial: Partial<MatchSettings>): void {
    onChange({ ...settings, ...partial })
  }

  /** Swaps in the other game's roster instead of discarding the current one. */
  function selectGame(game: GameKind): void {
    if (game === settings.game) return
    const benched = { ...settings.benched, [settings.game]: settings.players }
    onChange({ ...settings, game, players: benched[game] ?? [], benched })
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-suit brand-spade">♠</span>
        <span className="brand-text">LLM Cardroom</span>
        <span className="brand-suit brand-heart">♥</span>
      </div>

      <ApiKeySection
        hasApiKey={hasApiKey}
        keyCheck={props.keyCheck}
        keyStorage={props.keyStorage}
        onSave={props.onSaveApiKey}
        onVerify={props.onVerifyApiKey}
      />

      <section className="panel">
        <h3>Game</h3>
        <div className="segmented">
          <button
            className={settings.game === 'blackjack' ? 'active' : ''}
            disabled={locked}
            onClick={() => selectGame('blackjack')}
          >
            Blackjack
          </button>
          <button
            className={settings.game === 'poker' ? 'active' : ''}
            disabled={locked}
            onClick={() => selectGame('poker')}
          >
            Hold'em
          </button>
        </div>
        <p className="panel-hint">
          {settings.game === 'blackjack'
            ? 'One model plays against the house dealer.'
            : "Two to eight models play No-Limit Texas Hold'em against each other."}
        </p>
      </section>

      <section className="panel">
        <h3>
          Players
          <span className="count">
            {players.length} / {maxPlayers}
          </span>
        </h3>

        {players.length === 0 && <p className="panel-empty">No models seated yet.</p>}

        <ul className="player-list">
          {players.map((player, index) => (
            <PlayerRow
              key={player.id}
              player={player}
              index={index}
              locked={locked}
              rosterLocked={rosterLocked}
              seated={props.seatedPlayerIds.includes(player.id)}
              onRename={(name) => {
                const next = players.map((p) => (p.id === player.id ? { ...p, name } : p))
                patch({ players: next })
              }}
              onEffort={(reasoningEffort) => {
                const next = players.map((p) => (p.id === player.id ? { ...p, reasoningEffort } : p))
                patch({ players: next })
              }}
              onReplace={() => props.onReplacePlayer(player.id)}
              onRemove={() => props.onRemovePlayer(player.id)}
            />
          ))}
        </ul>

        <button
          className="primary-button block"
          disabled={rosterLocked || players.length >= maxPlayers}
          onClick={props.onAddPlayer}
        >
          + Add model
        </button>
        {running && settings.game === 'poker' && (
          <p className="panel-hint">
            Seats added or removed now take effect from the next hand. A player
            who leaves takes their chips; a player who joins buys in for{' '}
            {settings.poker.startingStack}.
          </p>
        )}
      </section>

      {settings.game === 'blackjack' ? (
        <section className="panel">
          <h3>Table rules</h3>
          <Field label="Starting bankroll">
            <NumberInput
              value={settings.blackjack.startingBankroll}
              min={100}
              step={100}
              disabled={locked}
              onChange={(startingBankroll) =>
                patch({ blackjack: { ...settings.blackjack, startingBankroll } })
              }
            />
          </Field>
          {/* Editable mid-match: a new stake applies from the next round. */}
          <Field label={settings.blackjack.modelChoosesBet ? 'Table minimum' : 'Bet per hand'}>
            <NumberInput
              value={settings.blackjack.baseBet}
              min={5}
              step={5}
              onChange={(baseBet) => patch({ blackjack: { ...settings.blackjack, baseBet } })}
            />
          </Field>
          <Toggle
            label="Model chooses its own bet"
            checked={settings.blackjack.modelChoosesBet}
            onChange={(modelChoosesBet) =>
              patch({ blackjack: { ...settings.blackjack, modelChoosesBet } })
            }
          />
          {settings.blackjack.modelChoosesBet && (
            <p className="panel-hint">
              Before each deal the model is shown its bankroll and record, then
              picks a wager between the table minimum and its whole bankroll.
            </p>
          )}
          {running && (
            <p className="panel-hint">
              Stake changes take effect on the next round, not the hand in play.
            </p>
          )}
          <Field label="Decks in shoe">
            <NumberInput
              value={settings.blackjack.deckCount}
              min={1}
              max={8}
              disabled={locked}
              onChange={(deckCount) => patch({ blackjack: { ...settings.blackjack, deckCount } })}
            />
          </Field>
          <Toggle
            label="Offer insurance on dealer ace"
            checked={settings.blackjack.offerInsurance}
            disabled={locked}
            onChange={(offerInsurance) =>
              patch({ blackjack: { ...settings.blackjack, offerInsurance } })
            }
          />
          <Toggle
            label="Dealer hits soft 17"
            checked={settings.blackjack.dealerHitsSoft17}
            disabled={locked}
            onChange={(dealerHitsSoft17) =>
              patch({ blackjack: { ...settings.blackjack, dealerHitsSoft17 } })
            }
          />
          <Toggle
            label="Double after split"
            checked={settings.blackjack.doubleAfterSplit}
            disabled={locked}
            onChange={(doubleAfterSplit) =>
              patch({ blackjack: { ...settings.blackjack, doubleAfterSplit } })
            }
          />
        </section>
      ) : (
        <section className="panel">
          <h3>Table rules</h3>
          <Field label="Starting stack">
            <NumberInput
              value={settings.poker.startingStack}
              min={100}
              step={100}
              disabled={locked}
              onChange={(startingStack) => patch({ poker: { ...settings.poker, startingStack } })}
            />
          </Field>
          <Field label="Small blind">
            <NumberInput
              value={settings.poker.smallBlind}
              min={1}
              disabled={locked}
              onChange={(smallBlind) => patch({ poker: { ...settings.poker, smallBlind } })}
            />
          </Field>
          <Field label="Big blind">
            <NumberInput
              value={settings.poker.bigBlind}
              min={2}
              disabled={locked}
              onChange={(bigBlind) => patch({ poker: { ...settings.poker, bigBlind } })}
            />
          </Field>
          <Field label="Double blinds every">
            <NumberInput
              value={settings.poker.blindIncreaseEvery}
              min={0}
              disabled={locked}
              suffix="hands (0 = never)"
              onChange={(blindIncreaseEvery) =>
                patch({ poker: { ...settings.poker, blindIncreaseEvery } })
              }
            />
          </Field>
          <p className="panel-hint">
            You see every hole card, like a televised table. Each model still
            sees only its own.
          </p>
        </section>
      )}

      <section className="panel">
        <h3>Pace</h3>
        <Field label="Delay between steps">
          <input
            type="range"
            min={0}
            max={3000}
            step={100}
            value={settings.stepDelayMs}
            onChange={(event) => patch({ stepDelayMs: Number(event.target.value) })}
          />
          <span className="range-value">{(settings.stepDelayMs / 1000).toFixed(1)}s</span>
        </Field>
        <Field label={settings.game === 'blackjack' ? 'Stop after rounds' : 'Stop after hands'}>
          <NumberInput
            value={settings.maxRounds}
            min={0}
            suffix="0 = no limit"
            onChange={(maxRounds) => patch({ maxRounds })}
          />
        </Field>
      </section>

      <div className="controls">
        {!running && (
          <button className="start-button" disabled={Boolean(readyText)} onClick={props.onStart}>
            Deal me in
          </button>
        )}
        {status === 'running' && (
          <button className="ghost-button block" onClick={props.onPause}>
            Pause
          </button>
        )}
        {status === 'paused' && (
          <button className="primary-button block" onClick={props.onResume}>
            Resume
          </button>
        )}
        {running && (
          <button className="danger-button block" onClick={props.onStop}>
            {status === 'stopping' ? 'Stopping…' : 'Stop'}
          </button>
        )}
        {readyText && !running && <p className="panel-warn">{readyText}</p>}
      </div>
    </aside>
  )
}

function describeReadiness(
  settings: MatchSettings,
  hasApiKey: boolean,
  minPlayers: number,
  maxPlayers: number,
  keyCheck: KeyCheck
): string {
  if (!hasApiKey) return 'Add your OpenRouter API key to begin.'
  if (keyCheck.state === 'bad') return 'The saved API key was rejected. Replace it before dealing in.'
  if (settings.players.length < minPlayers) {
    return settings.game === 'poker'
      ? `Seat at least ${minPlayers} models.`
      : 'Seat a model at the table.'
  }
  if (settings.players.length > maxPlayers) return `This game seats at most ${maxPlayers}.`
  if (settings.game === 'poker' && settings.poker.bigBlind <= settings.poker.smallBlind) {
    return 'The big blind must be larger than the small blind.'
  }
  if (settings.game === 'poker' && settings.poker.startingStack < settings.poker.bigBlind * 2) {
    return 'Starting stacks must cover at least two big blinds.'
  }
  if (settings.game === 'blackjack' && settings.blackjack.baseBet > settings.blackjack.startingBankroll) {
    return 'The bet per hand cannot exceed the bankroll.'
  }
  return ''
}

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  default: "Model's default",
  none: 'No reasoning',
  low: 'Low',
  medium: 'Medium',
  high: 'High'
}

function PlayerRow({
  player,
  index,
  locked,
  rosterLocked,
  seated,
  onRename,
  onEffort,
  onReplace,
  onRemove
}: {
  player: PlayerConfig
  index: number
  locked: boolean
  rosterLocked: boolean
  seated: boolean
  onRename: (name: string) => void
  onEffort: (value: ReasoningEffort) => void
  onReplace: () => void
  onRemove: () => void
}): React.JSX.Element {
  // Once a model is dealt in its setup is frozen; a model waiting to join is
  // still fully editable.
  const settingsLocked = locked && seated
  const [expanded, setExpanded] = useState(false)

  return (
    <li className="player-row">
      <div className="player-head">
        <span className={`player-index${locked && !seated ? ' player-pending' : ''}`}>
          {locked && !seated ? '·' : index + 1}
        </span>
        <input
          className="player-name"
          value={player.name}
          disabled={locked}
          maxLength={22}
          onChange={(event) => onRename(event.target.value)}
        />
        <button
          className="icon-button"
          title="Player options"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <button
          className="icon-button danger"
          title={rosterLocked ? 'Remove' : 'Remove after this hand'}
          disabled={rosterLocked}
          onClick={onRemove}
        >
          ×
        </button>
      </div>
      <div className="player-model" title={player.modelId}>
        {player.modelId}
      </div>
      {locked && !seated && (
        <div className="player-waiting">joins next hand — set up now</div>
      )}
      {expanded && (
        <div className="player-detail">
          <label className="effort-row">
            <span>Reasoning effort</span>
            <select
              value={player.reasoningEffort}
              disabled={settingsLocked}
              onChange={(event) => onEffort(event.target.value as ReasoningEffort)}
            >
              {REASONING_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {EFFORT_LABEL[effort]}
                </option>
              ))}
            </select>
          </label>
          <p className="panel-hint">
            {settingsLocked
              ? 'Fixed for this match: a model that thinks differently is a different player.'
              : locked
                ? 'Adjustable until this model is dealt in on the next hand.'
                : 'Ignored by models that cannot reason. Higher effort thinks longer and costs more per decision.'}
          </p>
          <button className="ghost-button block" disabled={settingsLocked} onClick={onReplace}>
            Change model
          </button>
        </div>
      )}
    </li>
  )
}

const KEY_BADGE: Record<KeyCheck['state'], { text: string; className: string }> = {
  unknown: { text: 'no key', className: 'badge-warn' },
  checking: { text: 'checking…', className: '' },
  ok: { text: 'key works', className: 'badge-ok' },
  bad: { text: 'key rejected', className: 'badge-bad' }
}

/**
 * What the app can honestly claim about the key on disk. Only the keychain case
 * is real encryption; the Linux fallback is obfuscation with a hardcoded key,
 * so it gets a warning rather than reassurance.
 */
const KEY_STORAGE_NOTE: Record<KeyStorageKind, { text: string; warn: boolean }> = {
  'os-keychain': {
    text: "Stored in this machine's credential store.",
    warn: false
  },
  obfuscated: {
    text:
      'No desktop keyring was found, so the key is only obfuscated in the ' +
      'config file — not encrypted. Install gnome-keyring or KWallet for real ' +
      'protection.',
    warn: true
  },
  plaintext: {
    text: 'This system offers no encryption, so the key is stored as clear text.',
    warn: true
  }
}

function ApiKeySection({
  hasApiKey,
  keyCheck,
  keyStorage,
  onSave,
  onVerify
}: {
  hasApiKey: boolean
  keyCheck: KeyCheck
  keyStorage: KeyStorageKind
  onSave: (key: string) => Promise<void>
  onVerify: (key: string) => Promise<{ ok: boolean; detail: string }>
}): React.JSX.Element {
  const storageNote = KEY_STORAGE_NOTE[keyStorage]
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  // Derived rather than initial state: `hasApiKey` arrives asynchronously, so
  // seeding `useState` from it would leave the form open on every launch.
  const open = editing || !hasApiKey || keyCheck.state === 'bad'

  // A stored key only counts as present once it has actually been checked.
  const badge = hasApiKey ? KEY_BADGE[keyCheck.state] : KEY_BADGE.unknown

  async function save(): Promise<void> {
    setBusy(true)
    setStatus('Checking…')
    const result = await onVerify(value)
    if (result.ok) {
      await onSave(value)
      setStatus(result.detail)
      setValue('')
      setEditing(false)
    } else {
      setStatus(result.detail)
    }
    setBusy(false)
  }

  return (
    <section className="panel">
      <h3>
        OpenRouter
        <span className={`badge ${badge.className}`}>{badge.text}</span>
      </h3>

      {hasApiKey && keyCheck.state === 'bad' && (
        <p className="panel-error">
          The saved key did not work: {keyCheck.detail} Replace it before dealing in.
        </p>
      )}

      {!open ? (
        <button className="ghost-button block" onClick={() => setEditing(true)}>
          Replace API key
        </button>
      ) : (
        <>
          <input
            className="key-input"
            type="password"
            placeholder="sk-or-v1-…"
            value={value}
            spellCheck={false}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && value.trim()) void save()
            }}
          />
          <div className="key-actions">
            <button className="primary-button" disabled={!value.trim() || busy} onClick={() => void save()}>
              Save key
            </button>
            {hasApiKey && keyCheck.state !== 'bad' && (
              <button className="ghost-button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </>
      )}

      {/* A weak-storage warning stays visible with the form closed: hiding it
          behind "Replace API key" would mean nobody ever reads it. */}
      {(open || storageNote.warn) && (
        <p className={storageNote.warn ? 'panel-warn' : 'panel-hint'}>
          {storageNote.text}{' '}
          {open && (
            <a
              href="#"
              onClick={(event) => {
                event.preventDefault()
                void window.cardroom.openExternal('https://openrouter.ai/keys')
              }}
            >
              Get a key
            </a>
          )}
        </p>
      )}
      {status && <p className="panel-status">{status}</p>}
      {status.startsWith('Key accepted') && (
        <p className="panel-hint">
          That is the key's lifetime total on OpenRouter. What this app spends is
          in the Usage tab.
        </p>
      )}
    </section>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-control">{children}</span>
    </label>
  )
}

/**
 * Spinner arrows step from `min`, not from zero, so callers should keep `min`
 * a multiple of `step` — otherwise a min of 1 with a step of 5 yields 1, 6, 11.
 */
function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  suffix
}: {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  suffix?: string
}): React.JSX.Element {
  return (
    <>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next)) onChange(next)
        }}
      />
      {suffix && <span className="field-suffix">{suffix}</span>}
    </>
  )
}

function Toggle({
  label,
  checked,
  onChange,
  disabled
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}
