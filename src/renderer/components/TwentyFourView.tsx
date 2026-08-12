import { cardCode } from '../../shared/cards.ts'
import type {
  MatchSettings,
  TwentyFourPlayer,
  TwentyFourResult,
  TwentyFourState
} from '../../shared/types.ts'
import { PlayingCard } from './PlayingCard.tsx'

interface Props {
  state: TwentyFourState
  thinking: Record<string, boolean>
  targetScore: number
}

/** A = 1, J = 11, Q = 12, K = 13. Mirrors `puzzleValue` in the engine. */
function value(rank: number): number {
  return rank === 14 ? 1 : rank
}

export function emptyTwentyFourState(settings: MatchSettings): TwentyFourState {
  return {
    kind: 'twentyfour',
    phase: 'idle',
    roundNumber: 0,
    roundsPlayed: 0,
    cards: [],
    solvable: false,
    solution: null,
    players: settings.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      modelId: player.modelId,
      seatIndex: index,
      score: 0,
      solved: 0,
      missed: 0,
      wrong: 0,
      invalid: 0,
      roundsPlayed: 0,
      latencies: []
    })),
    results: []
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

export function TwentyFourView({ state, thinking, targetScore }: Props): React.JSX.Element {
  const players = state.players
  const answering = state.phase === 'answering'
  const settled = state.phase === 'settled' || state.phase === 'complete'

  const attempts = players.reduce((sum, p) => sum + p.roundsPlayed, 0)
  const solved = players.reduce((sum, p) => sum + p.solved, 0)
  const solveRate = attempts > 0 ? Math.round((solved / attempts) * 100) : 0
  const allLatencies = players.flatMap((p) => p.latencies)
  const best = players.length ? Math.max(...players.map((p) => p.score)) : 0

  return (
    <div className="felt felt-24">
      <div className="tf-puzzle">
        <div className="tf-head">
          {state.phase === 'idle' ? 'Waiting to start' : `Puzzle ${state.roundNumber}`}
        </div>
        <div className="tf-cards">
          {state.cards.length === 0
            ? Array.from({ length: 4 }).map((_, index) => (
                <div key={`slot-${index}`} className="card-placeholder card-lg" />
              ))
            : state.cards.map((card, index) => (
                <div key={`${cardCode(card)}-${index}`} className="tf-card">
                  <PlayingCard card={card} size="lg" />
                  {/* Spelled out, because ace = 1 and king = 13 are a choice —
                      the other common variant makes every face card 10. */}
                  <span className="tf-card-value">{value(card.rank)}</span>
                </div>
              ))}
        </div>
        <div className="tf-target">
          {state.cards.length > 0
            ? `${state.cards.map((c) => value(c.rank)).join('  ·  ')}   →   24`
            : 'Four cards · + − × ÷ · make 24'}
        </div>
        {/* The solution is spectator-only, exactly like poker win probability,
            and is revealed only once the round is over. */}
        {settled && (
          <div className={state.solvable ? 'tf-solution' : 'tf-solution tf-solution-none'}>
            {state.solvable ? `Solution: ${state.solution} = 24` : 'No solution existed'}
          </div>
        )}
        {answering && <div className="tf-racing">All models are answering…</div>}
      </div>

      <div className="tf-board">
        {players.length === 0 && <div className="empty-hand">No models seated yet.</div>}
        {players.map((player) => (
          <ResultRow
            key={player.id}
            player={player}
            result={player.lastResult}
            thinking={Boolean(thinking[player.id])}
            leading={player.score === best && best > 0}
            answering={answering}
          />
        ))}
      </div>

      <div className="bj-stats">
        <Stat label="Puzzle" value={String(state.roundNumber)} title="Puzzles dealt so far" />
        <Stat
          label="Solve rate"
          value={attempts > 0 ? `${solveRate}%` : '—'}
          title="Correct answers as a share of every answer given, across the whole table"
        />
        <Stat
          label="Median time"
          value={allLatencies.length ? `${(median(allLatencies) / 1000).toFixed(1)}s` : '—'}
          title="Typical answering time — the model's own attempt, with retries excluded"
        />
        <Stat
          label="Target"
          value={targetScore > 0 ? String(targetScore) : '∞'}
          title="Rounds a model must win to take the match; ∞ runs until stopped"
        />
      </div>
    </div>
  )
}

const VERDICT_LABEL: Record<string, string> = {
  correct: 'correct',
  wrong: 'wrong',
  invalid: 'invalid',
  none: 'no answer'
}

function ResultRow({
  player,
  result,
  thinking,
  leading,
  answering
}: {
  player: TwentyFourPlayer
  result?: TwentyFourResult
  thinking: boolean
  leading: boolean
  answering: boolean
}): React.JSX.Element {
  const classes = ['tf-row']
  if (result?.won) classes.push('tf-row-won')
  if (thinking) classes.push('tf-row-thinking')
  if (leading) classes.push('tf-row-leading')

  return (
    <div className={classes.join(' ')}>
      <div className="tf-row-who">
        <span className={`seat-name${thinking ? ' seat-thinking' : ''}`}>
          <span className="seat-name-text">{player.name}</span>
          {thinking && <span className="dots"><i /><i /><i /></span>}
        </span>
        <span className="seat-model">{player.modelId}</span>
      </div>

      <div className="tf-row-answer">
        {thinking || (answering && !result) ? (
          <span className="tf-thinking-text">thinking…</span>
        ) : result ? (
          <>
            <code className="tf-expression">
              {result.expression === null ? 'no solution' : result.expression}
            </code>
            <span className={`tf-verdict tf-verdict-${result.verdict}`}>
              {VERDICT_LABEL[result.verdict]}
              {result.verdict === 'wrong' && result.valueLabel ? ` (= ${result.valueLabel})` : ''}
            </span>
          </>
        ) : (
          <span className="tf-thinking-text">—</span>
        )}
      </div>

      <div className="tf-row-time">
        {result && Number.isFinite(result.elapsedMs)
          ? `${(result.elapsedMs / 1000).toFixed(1)}s`
          : ''}
      </div>

      <div className="tf-row-score" title={`${player.solved} solved of ${player.roundsPlayed}`}>
        {player.score}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  title
}: {
  label: string
  value: string
  title?: string
}): React.JSX.Element {
  return (
    <div className="stat" title={title}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  )
}
