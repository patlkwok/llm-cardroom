import { useState } from 'react'
import type { KeyCheck } from '../App.tsx'
import {
  GAME_KINDS,
  GAMES,
  REASONING_EFFORTS,
  type GameKind,
  type KeyStorageKind,
  type MatchSettings,
  type MatchStatus,
  type PlayerConfig,
  type ReasoningEffort
} from '../../shared/types.ts'
import { Field, NumberInput, Toggle } from './setup/controls.tsx'
import { RULES_PANELS } from './setup/rulesPanels.tsx'

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

/** What each game is for, in one line, under the selector. */
const GAME_BLURB: Record<GameKind, (settings: MatchSettings) => string> = {
  blackjack: (s) =>
    `One to ${GAMES.blackjack.maxPlayers} models play the house dealer, sharing a single shoe. ` +
    'They never play each other, but they see the same cards burn.',
  poker: () => `Two to ${GAMES.poker.maxPlayers} models play No-Limit Texas Hold'em against each other.`,
  hearts: () =>
    'Exactly four models pass three cards and play thirteen tricks, dodging hearts and ' +
    'the queen of spades. Lowest score wins.',
  twentyfour: (s) =>
    `Up to ${GAMES.twentyfour.maxPlayers} models race the same four cards to 24, all answering at once. ` +
    `First correct answer takes the ${GAMES.twentyfour.roundNoun}.`
}

export function SetupPanel(props: Props): React.JSX.Element {
  const { settings, onChange, status, hasApiKey } = props
  const running = status === 'running' || status === 'paused' || status === 'stopping'
  const locked = running
  const players = settings.players
  const game = GAMES[settings.game]
  const { minPlayers, maxPlayers } = game
  // A fixed-roster game locks its whole line-up at the first deal, so its seats
  // cannot be added to or taken from mid-match at all.
  const rosterLocked = locked && game.fixedRoster
  const exactPlayers = minPlayers === maxPlayers

  const readyText = describeReadiness(settings, hasApiKey, props.keyCheck)
  const RulesPanel = RULES_PANELS[settings.game]

  function patch(partial: Partial<MatchSettings>): void {
    onChange({ ...settings, ...partial })
  }

  /** Swaps in the other game's roster instead of discarding the current one. */
  function selectGame(next: GameKind): void {
    if (next === settings.game) return
    const benched = { ...settings.benched, [settings.game]: settings.players }
    onChange({ ...settings, game: next, players: benched[next] ?? [], benched })
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
        {/* Two columns, so four games land as a 2x2 rather than four slivers. */}
        <div className="segmented">
          {GAME_KINDS.map((kind) => (
            <button
              key={kind}
              className={settings.game === kind ? 'active' : ''}
              disabled={locked}
              title={GAMES[kind].label}
              onClick={() => selectGame(kind)}
            >
              {GAMES[kind].shortLabel}
            </button>
          ))}
        </div>
        <p className="panel-hint">{GAME_BLURB[settings.game](settings)}</p>
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
              roundNoun={game.roundNoun}
              seated={props.seatedPlayerIds.includes(player.id)}
              onRename={(name) => {
                const next = players.map((p) => (p.id === player.id ? { ...p, name } : p))
                patch({ players: next })
              }}
              onEffort={(reasoningEffort) => {
                const next = players.map((p) => (p.id === player.id ? { ...p, reasoningEffort } : p))
                patch({ players: next })
              }}
              canRemove={!rosterLocked}
              onReplace={() => props.onReplacePlayer(player.id)}
              onRemove={() => props.onRemovePlayer(player.id)}
            />
          ))}
        </ul>

        <button
          className="primary-button block"
          disabled={players.length >= maxPlayers || rosterLocked}
          onClick={props.onAddPlayer}
        >
          + Add model
        </button>
        {/* A game that seats an exact number should say so, rather than offering
            an Add button that cannot help. */}
        {exactPlayers && players.length !== minPlayers && (
          <p className="panel-hint">
            {game.label} needs exactly {minPlayers} models — {players.length} seated.
          </p>
        )}
        {running && rosterLocked && (
          <p className="panel-hint">
            {game.label} locks its table for the whole match: nobody joins or
            leaves once the first {game.roundNoun} is dealt.
          </p>
        )}
        {running && !rosterLocked && (
          <p className="panel-hint">
            Seats added or removed now take effect from the next {game.roundNoun}.
            A player who leaves takes their chips; a player who joins buys in for{' '}
            {settings.game === 'poker'
              ? settings.poker.startingStack
              : settings.blackjack.startingBankroll}
            .
          </p>
        )}
      </section>

      <section className="panel">
        <h3>Table rules</h3>
        <RulesPanel
          settings={settings}
          patch={patch}
          locked={locked}
          running={running}
          playerCount={players.length}
        />
      </section>

      <section className="panel">
        <h3>Pace</h3>
        <Field label={game.simultaneous ? 'Delay between rounds' : 'Delay between steps'}>
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
        {/* A simultaneous round takes as long as its slowest model, so there are
            no steps within it for a delay to sit between. */}
        {game.simultaneous && (
          <p className="panel-hint">
            A round lasts as long as the slowest model takes to answer, so this
            paces the gap between puzzles rather than between steps.
          </p>
        )}
        <Field label={`Stop after ${game.roundNoun}s`}>
          <NumberInput
            value={settings.maxRounds}
            min={0}
            suffix="0 = no limit"
            onChange={(maxRounds) => patch({ maxRounds })}
          />
        </Field>
        {settings.game === 'poker' && (
          <>
            <Toggle
              label="Show win probability"
              checked={settings.showEquity}
              onChange={(showEquity) => patch({ showEquity })}
            />
            <p className="panel-hint">
              Each seat's chance of winning the hand, as a televised table shows
              it. Costs nothing to run — it is your CPU, not an API call — but it
              is a few hundred milliseconds per board change, so turn it off if
              you want the table to rip along. The models never see it.
            </p>
          </>
        )}
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
  keyCheck: KeyCheck
): string {
  const { label, minPlayers, maxPlayers } = GAMES[settings.game]
  if (!hasApiKey) return 'Add your OpenRouter API key to begin.'
  if (keyCheck.state === 'bad') return 'The saved API key was rejected. Replace it before dealing in.'

  const seated = settings.players.length
  if (minPlayers === maxPlayers && seated !== minPlayers) {
    return `${label} needs exactly ${minPlayers} models; ${seated} are seated.`
  }
  if (seated < minPlayers) {
    return minPlayers > 1 ? `Seat at least ${minPlayers} models.` : 'Seat a model at the table.'
  }
  if (seated > maxPlayers) return `This game seats at most ${maxPlayers}.`

  if (settings.game === 'poker' && settings.poker.bigBlind <= settings.poker.smallBlind) {
    return 'The big blind must be larger than the small blind.'
  }
  if (settings.game === 'poker' && settings.poker.startingStack < settings.poker.bigBlind * 2) {
    return 'Starting stacks must cover at least two big blinds.'
  }
  if (settings.game === 'blackjack' && settings.blackjack.baseBet > settings.blackjack.startingBankroll) {
    return 'The bet per hand cannot exceed the bankroll.'
  }
  if (settings.game === 'hearts' && settings.hearts.targetScore < 25) {
    return 'A game of hearts needs a target of at least 25 points.'
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
  roundNoun,
  seated,
  canRemove,
  onRename,
  onEffort,
  onReplace,
  onRemove
}: {
  player: PlayerConfig
  index: number
  locked: boolean
  roundNoun: string
  seated: boolean
  canRemove: boolean
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
        {/* Editable until the model is actually dealt in, exactly like its
            reasoning effort and its model. Only a seat already at the table is
            frozen — its name is already on the felt and in the log. */}
        <input
          className="player-name"
          value={player.name}
          disabled={settingsLocked}
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
          disabled={!canRemove}
          title={
            !canRemove
              ? 'This table is fixed for the whole match'
              : locked
                ? `Remove after this ${roundNoun}`
                : 'Remove'
          }
          onClick={onRemove}
        >
          ×
        </button>
      </div>
      <div className="player-model" title={player.modelId}>
        {player.modelId}
      </div>
      {locked && !seated && (
        <div className="player-waiting">joins next {roundNoun} — set up now</div>
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
                ? `Adjustable until this model is dealt in on the next ${roundNoun}.`
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
