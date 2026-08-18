import { cardCode, type Card } from '../../shared/cards.ts'
import type { TrickBase } from '../../shared/types.ts'
import { PlayingCard } from './PlayingCard.tsx'

/**
 * The furniture every trick-taking felt shares: four seats round a compass, a
 * hand fanned at each, and the trick in the middle.
 *
 * Written when Spades arrived rather than copied from Hearts. A per-view copy
 * of a rule is a rule the next view forgets — the `text-overflow: ellipsis` fix
 * for long seat names was written twice and then missing from the third felt,
 * and it was only ever visible in a rendered frame.
 */

export type Compass = 'south' | 'west' | 'north' | 'east'

/**
 * Seat 0 sits south and play passes to the left, so the seats run
 * south → west → north → east round the table.
 */
export const COMPASS: Compass[] = ['south', 'west', 'north', 'east']

/** East and west are narrow columns, so their hands fan downwards. */
export function isVertical(position: Compass): boolean {
  return position === 'east' || position === 'west'
}

export function TrickTable({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="trick-table">{children}</div>
}

export function TrickSeat({
  position,
  acting,
  leader,
  children
}: {
  position: Compass
  /** On turn, or waiting on its model — both get the same highlight. */
  acting: boolean
  /** Winning, in whichever direction this game counts. */
  leader: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const classes = ['trick-seat', `trick-seat-${position}`]
  if (acting) classes.push('trick-seat-acting')
  if (leader) classes.push('trick-seat-leader')
  return <div className={classes.join(' ')}>{children}</div>
}

/** Name, thinking dots and model id, with whatever the game counts in between. */
export function SeatPlate({
  name,
  modelId,
  thinking,
  children
}: {
  name: string
  modelId: string
  thinking: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="trick-plate">
      <span className={`seat-name${thinking ? ' seat-thinking' : ''}`}>
        {/* The name needs its own element: text-overflow does not apply to a
            flex container, so putting it directly here clips long names
            mid-character instead of ellipsising them. */}
        <span className="seat-name-text">{name}</span>
        {thinking && <span className="dots"><i /><i /><i /></span>}
      </span>
      {children}
      <div className="seat-model">{modelId}</div>
    </div>
  )
}

export function SeatHand({
  cards,
  position,
  emptyText,
  marked = [],
  marking = 'out'
}: {
  cards: Card[]
  position: Compass
  emptyText: string
  /** Cards to single out — the three leaving a hand, or the three arriving. */
  marked?: Card[]
  marking?: 'out' | 'in'
}): React.JSX.Element {
  return (
    <div className="trick-hand">
      {cards.length === 0 ? (
        <div className="trick-empty-hand">{emptyText}</div>
      ) : (
        // The spectator sees every hand, exactly as at poker. The models never
        // do: their prompts render only their own.
        <Fan cards={cards} position={position} marked={marked} marking={marking} />
      )}
    </div>
  )
}

/**
 * Thirteen cards will not fit side by side on a felt this narrow, so they
 * overlap. Width is the layout risk on the north/south axis and *height* is the
 * risk on the east/west one — which is why those fan downwards, at a deeper
 * overlap, with the card corner laid out sideways.
 */
function Fan({
  cards,
  position,
  marked,
  marking
}: {
  cards: Card[]
  position: Compass
  marked: Card[]
  marking: 'out' | 'in'
}): React.JSX.Element {
  const isMarked = (card: Card): boolean =>
    marked.some((c) => c.rank === card.rank && c.suit === card.suit)

  return (
    <div className={isVertical(position) ? 'card-fan card-fan-down' : 'card-fan'}>
      {cards.map((card) => (
        <span
          key={cardCode(card)}
          className={
            isMarked(card) ? `card-slot card-pass-${marking} card-pass-${position}` : 'card-slot'
          }
        >
          <PlayingCard card={card} size="sm" />
        </span>
      ))}
    </div>
  )
}

export function TrickCentre({
  heading,
  children
}: {
  heading: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="trick-centre">
      <div className="trick-head">{heading}</div>
      {children}
    </div>
  )
}

/** The four cards on the table. Always a 2x2, so they never wrap three-then-one. */
export function TrickCards({
  trick,
  nameOf,
  emptyText
}: {
  trick: TrickBase | null
  nameOf: (seatIndex: number) => string
  emptyText: string
}): React.JSX.Element {
  return (
    <div className="trick-cards">
      {trick && trick.plays.length > 0 ? (
        trick.plays.map((play) => (
          <div
            key={`${play.seatId}-${cardCode(play.card)}`}
            className={
              'trick-play' + (trick.winnerSeatIndex === play.seatIndex ? ' trick-winner' : '')
            }
          >
            <PlayingCard card={play.card} size="md" />
            <span className="trick-who">{nameOf(play.seatIndex)}</span>
          </div>
        ))
      ) : (
        <div className="trick-empty">{emptyText}</div>
      )}
    </div>
  )
}

/**
 * Who took it. This gets a step of its own before the cards are swept up —
 * resolving a trick and opening the next one in the same frame meant the
 * operator never saw who won anything.
 */
export function TrickResult({
  winnerName,
  children
}: {
  winnerName: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="trick-result">
      <span className="trick-takes">{winnerName} takes it</span>
      {children}
    </div>
  )
}

export function TrickFlag({ on, children }: { on: boolean; children: React.ReactNode }): React.JSX.Element {
  return <span className={on ? 'trick-flag on' : 'trick-flag'}>{children}</span>
}

export function Stat({
  label,
  value,
  tone,
  title
}: {
  label: string
  value: string
  tone?: 'good' | 'bad'
  title?: string
}): React.JSX.Element {
  return (
    <div className="stat" title={title}>
      <div className="stat-label">{label}</div>
      <div className={`stat-value${tone ? ` stat-${tone}` : ''}`}>{value}</div>
    </div>
  )
}
