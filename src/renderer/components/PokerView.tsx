import type { PokerSeat, PokerState } from '../../shared/types.ts'
import { CardRow, PlayingCard } from './PlayingCard.tsx'

interface Props {
  state: PokerState
  thinking: Record<string, boolean>
}

/**
 * Seat coordinates around an ellipse, starting at the bottom centre. The radii
 * stay inside the felt so seat plates at the far left and right are not clipped.
 */
function seatPosition(index: number, total: number): { left: string; top: string } {
  const angle = Math.PI / 2 + (index * 2 * Math.PI) / total
  const left = 50 + 37 * Math.cos(angle)
  const top = 50 + 34 * Math.sin(angle)
  return { left: `${left}%`, top: `${top}%` }
}

export function PokerView({ state, thinking }: Props): React.JSX.Element {
  const total = state.seats.length

  return (
    <div className="felt felt-poker">
      <div className="poker-centre">
        <div className="poker-street">
          {state.phase === 'idle' ? 'Waiting to start' : `Hand ${state.handNumber} · ${state.street}`}
        </div>
        <div className="board">
          {state.board.map((card, index) => (
            <PlayingCard key={`${card.rank}${card.suit}-${index}`} card={card} size="lg" />
          ))}
          {Array.from({ length: Math.max(0, 5 - state.board.length) }).map((_, index) => (
            <div key={`slot-${index}`} className="card-placeholder card-lg" />
          ))}
        </div>
        <div className="pot">
          <span className="pot-label">Pot</span>
          <span className="pot-value">{state.pot}</span>
        </div>
        {state.sidePots.length > 1 && (
          <div className="sidepots">
            {state.sidePots.map((pot, index) => (
              <span key={index} className="sidepot">
                {index === 0 ? 'Main' : `Side ${index}`} {pot.amount}
              </span>
            ))}
          </div>
        )}
        {state.lastHandSummary && <div className="hand-summary">{state.lastHandSummary}</div>}
      </div>

      {state.seats.map((seat, index) => (
        <SeatBox
          key={seat.id}
          seat={seat}
          style={seatPosition(index, total)}
          isButton={index === state.buttonIndex}
          isActing={index === state.actingSeatIndex}
          thinking={Boolean(thinking[seat.id])}
          bigBlind={state.bigBlind}
        />
      ))}
    </div>
  )
}

function SeatBox({
  seat,
  style,
  isButton,
  isActing,
  thinking,
  bigBlind
}: {
  seat: PokerSeat
  style: { left: string; top: string }
  isButton: boolean
  isActing: boolean
  thinking: boolean
  bigBlind: number
}): React.JSX.Element {
  const classes = ['poker-seat']
  if (seat.folded && !seat.busted) classes.push('seat-folded')
  if (seat.busted) classes.push('seat-busted')
  if (isActing || thinking) classes.push('seat-acting')
  if (seat.wonThisHand > 0) classes.push('seat-winner')

  const bigBlinds = bigBlind > 0 ? (seat.stack / bigBlind).toFixed(0) : '0'

  return (
    <div className={classes.join(' ')} style={style}>
      <div className="seat-cards">
        {seat.busted ? (
          <div className="seat-out">OUT</div>
        ) : seat.cards.length ? (
          // The spectator always sees every hand; the models never do.
          <CardRow cards={seat.cards} size="sm" />
        ) : (
          <div className="card-placeholder card-sm" />
        )}
      </div>

      <div className="seat-plate">
        <div className="seat-plate-top">
          <span className="seat-name">
            {/* The name needs its own element: text-overflow does not apply to
                a flex container, so putting it directly here clipped long names
                mid-character instead of ellipsising them. */}
            <span className="seat-name-text">{seat.name}</span>
            {thinking && <span className="dots"><i /><i /><i /></span>}
          </span>
          {isButton && <span className="dealer-button">D</span>}
        </div>
        <div className="seat-plate-bottom">
          <span className="seat-stack">{seat.busted ? 'eliminated' : `${seat.stack}`}</span>
          {!seat.busted && <span className="seat-bb">{bigBlinds} BB</span>}
        </div>
        {seat.showdownHand && <div className="seat-showdown">{seat.showdownHand}</div>}
      </div>

      {seat.lastActionLabel && !seat.busted && (
        <div className="seat-action">{seat.lastActionLabel}</div>
      )}
      {seat.committed > 0 && (
        <div className="seat-bet">
          <span className="chip-dot" />
          {seat.committed}
        </div>
      )}
      {seat.wonThisHand > 0 && <div className="seat-won">+{seat.wonThisHand}</div>}
    </div>
  )
}
