import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  DecisionRecord,
  LogEntry,
  MatchSnapshot,
  PlayerConfig
} from '../../shared/types.ts'

interface Props {
  decisions: DecisionRecord[]
  log: LogEntry[]
  snapshot: MatchSnapshot | null
  players: PlayerConfig[]
}

type Tab = 'reasoning' | 'log' | 'usage'

/** Stable per-player accent colours so seats and feed entries match up. */
export const SEAT_COLOURS = [
  '#ffb454', '#63d2ff', '#8ce99a', '#ff8fa3',
  '#c3a6ff', '#ffe066', '#5fd3bc', '#ff9f6e'
]

export function colourFor(players: PlayerConfig[], playerId?: string): string {
  const index = players.findIndex((p) => p.id === playerId)
  return index >= 0 ? SEAT_COLOURS[index % SEAT_COLOURS.length] : '#8b949e'
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false })
}

/**
 * A model's reasoning, clamped to a few lines with a toggle when there is more.
 *
 * The toggle appears only when the text genuinely does not fit, which is
 * measured rather than guessed at from the character count: a short trace with
 * long words can overflow and a long one with short words may not. Reasoning
 * models on the 24 puzzle routinely produce far more than fits.
 */
function ReasoningText({ text }: { text: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const ref = useRef<HTMLParagraphElement>(null)

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    // Only meaningful while clamped; once expanded the element is its own size.
    if (!expanded) setOverflows(node.scrollHeight - node.clientHeight > 2)
  }, [text, expanded])

  return (
    <>
      <p ref={ref} className={expanded ? 'thought-text' : 'thought-text thought-clamped'}>
        {text}
      </p>
      {(overflows || expanded) && (
        <button className="thought-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less ▴' : 'Show more ▾'}
        </button>
      )}
    </>
  )
}

export function FeedPanel({ decisions, log, snapshot, players }: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('reasoning')
  const [pinned, setPinned] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pinned) return
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [decisions, log, tab, pinned])

  function handleScroll(): void {
    const node = scrollRef.current
    if (!node) return
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 60
    setPinned(atBottom)
  }

  const totalCost = snapshot?.stats.reduce((sum, s) => sum + s.costUsd, 0) ?? 0

  return (
    <section className="feed">
      <div className="feed-tabs">
        <button className={tab === 'reasoning' ? 'active' : ''} onClick={() => setTab('reasoning')}>
          Reasoning
        </button>
        <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>
          Table log
        </button>
        <button className={tab === 'usage' ? 'active' : ''} onClick={() => setTab('usage')}>
          Usage
        </button>
      </div>

      <div className="feed-body" ref={scrollRef} onScroll={handleScroll}>
        {tab === 'reasoning' && (
          <>
            {decisions.length === 0 && (
              <p className="feed-empty">
                Every decision a model makes will appear here, in its own words.
              </p>
            )}
            {decisions.map((record) => (
              <article key={record.id} className="thought">
                <header>
                  <span className="thought-who" style={{ color: colourFor(players, record.playerId) }}>
                    {record.playerName}
                  </span>
                  <span className="thought-action">{record.actionLabel}</span>
                  <span className="thought-time">{timeOf(record.ts)}</span>
                </header>
                <ReasoningText text={record.reasoning || '(no reasoning given)'} />
                {record.fallback && (
                  <p className="thought-fallback">
                    The table played this for them: {record.fallback}
                  </p>
                )}
                <footer>
                  <span>{(record.latencyMs / 1000).toFixed(1)}s</span>
                  <span>
                    {record.promptTokens.toLocaleString()} in · {record.completionTokens.toLocaleString()} out
                  </span>
                  {record.costUsd > 0 && <span>${record.costUsd.toFixed(4)}</span>}
                  {record.attempts > 1 && (
                    <span className="warn">{record.attempts} attempts</span>
                  )}
                  {record.fallback && <span className="warn">fell back</span>}
                </footer>
              </article>
            ))}
          </>
        )}

        {tab === 'log' && (
          <>
            {log.length === 0 && <p className="feed-empty">The table log starts when you deal in.</p>}
            {log.map((entry) => (
              <div key={entry.id} className={`log-line log-${entry.level}`}>
                <span className="log-time">{timeOf(entry.ts)}</span>
                <span className="log-text" style={entry.playerId ? { color: colourFor(players, entry.playerId) } : undefined}>
                  {entry.text}
                </span>
              </div>
            ))}
          </>
        )}

        {tab === 'usage' && (
          <div className="usage">
            {(!snapshot || snapshot.stats.length === 0) && (
              <p className="feed-empty">Token and cost totals appear once play starts.</p>
            )}
            {snapshot?.stats.map((stat) => {
              const player = players.find((p) => p.id === stat.playerId)
              if (!player) return null
              return (
                <div key={stat.playerId} className="usage-row">
                  <div className="usage-head">
                    <span style={{ color: colourFor(players, stat.playerId) }}>{player.name}</span>
                    <span className="usage-cost">${stat.costUsd.toFixed(4)}</span>
                  </div>
                  <div className="usage-model">{player.modelId}</div>
                  <div className="usage-grid">
                    <span>{stat.decisions} decisions</span>
                    <span>{stat.avgLatencyMs} ms avg</span>
                    <span>{stat.promptTokens.toLocaleString()} in</span>
                    <span>{stat.completionTokens.toLocaleString()} out</span>
                    {stat.fallbacks > 0 && <span className="warn">{stat.fallbacks} fallbacks</span>}
                    {stat.errors > 0 && <span className="warn">{stat.errors} retries</span>}
                  </div>
                </div>
              )
            })}
            {totalCost > 0 && (
              <div className="usage-total">
                Session total <strong>${totalCost.toFixed(4)}</strong>
              </div>
            )}
          </div>
        )}
      </div>

      {!pinned && (
        <button
          className="jump-button"
          onClick={() => {
            setPinned(true)
            const node = scrollRef.current
            if (node) node.scrollTop = node.scrollHeight
          }}
        >
          Jump to latest ↓
        </button>
      )}
    </section>
  )
}
