import { describeValue, handValue } from '../../shared/blackjackValue.ts'
import type {
  BlackjackHand,
  BlackjackPlayer,
  BlackjackRules,
  BlackjackState,
  MatchSettings
} from '../../shared/types.ts'
import { CardRow } from './PlayingCard.tsx'

/** The felt before the first deal, so the seats are visible while setting up. */
export function emptyBlackjackState(settings: MatchSettings): BlackjackState {
  return {
    kind: 'blackjack',
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

interface Props {
  state: BlackjackState
  thinking: Record<string, boolean>
  rules: BlackjackRules
}

type CardSize = 'sm' | 'md' | 'lg'

const OUTCOME_LABEL: Record<string, string> = {
  blackjack: 'Blackjack!',
  win: 'Win',
  push: 'Push',
  lose: 'Loss'
}

/**
 * Six seats will not fit at the size one seat looks best at. Sized by hands
 * rather than seats, because a split puts two hands where one stood and is
 * exactly as demanding on the width as an extra seat would be.
 */
function cardSize(handCount: number): CardSize {
  if (handCount <= 2) return 'lg'
  if (handCount <= 4) return 'md'
  return 'sm'
}

export function BlackjackView({ state, thinking, rules }: Props): React.JSX.Element {
  const dealerVisible = state.dealerHoleHidden ? state.dealerCards.slice(0, 1) : state.dealerCards
  const dealerTotal = state.dealerCards.length
    ? state.dealerHoleHidden
      ? `${handValue(dealerVisible).total} + ?`
      : describeValue(state.dealerCards)
    : '—'

  const seats = state.players
  // A split seat asks for as much room as an extra seat does, so the felt is
  // sized by hands on the table, not by how many models are sitting at it.
  const handCount = seats.reduce((sum, player) => sum + Math.max(1, player.hands.length), 0)
  const size = cardSize(handCount)
  const total = (pick: (player: BlackjackPlayer) => number): number =>
    seats.reduce((sum, player) => sum + pick(player), 0)
  const sessionNet = Math.round(total((p) => p.sessionNet) * 100) / 100
  const multi = seats.length > 1

  return (
    <div className="felt felt-blackjack">
      <div className="bj-dealer">
        <div className="seat-label">
          <span className="seat-name">Dealer</span>
          <span className="seat-chip">{dealerTotal}</span>
        </div>
        <CardRow cards={state.dealerCards} hideAfterFirst={state.dealerHoleHidden} size="lg" />
      </div>

      <div className="felt-brand">
        <div className="felt-brand-title">LLM Cardroom</div>
        <div className="felt-brand-sub">
          {rules.blackjackPayout === 1.5 ? 'Blackjack pays 3 to 2' : `Blackjack pays ${rules.blackjackPayout} to 1`}
          {' · '}
          {rules.dealerHitsSoft17 ? 'Dealer hits soft 17' : 'Dealer stands on all 17s'}
        </div>
      </div>

      <div className="bj-seats">
        {seats.length === 0 && <div className="empty-hand">No models seated yet.</div>}
        {seats.map((seat) => (
          <SeatBox
            key={seat.id}
            seat={seat}
            size={size}
            acting={state.phase === 'player' && seat.seatIndex === state.activePlayerIndex}
            thinking={Boolean(thinking[seat.id])}
            phase={state.phase}
          />
        ))}
      </div>

      {/* Every figure here except the round and the shoe is a total across the
          whole table. The per-seat numbers live on the seat plates, so the
          labels say "table" out loud rather than leaving it to be guessed. */}
      <div className="bj-stats">
        <Stat label="Round" value={String(state.roundNumber)} title="Rounds dealt so far" />
        <Stat
          label={multi ? 'Table net' : 'Session'}
          value={`${sessionNet >= 0 ? '+' : ''}${sessionNet}`}
          tone={sessionNet > 0 ? 'good' : sessionNet < 0 ? 'bad' : undefined}
          title={
            multi
              ? `Every seat's session net added together, across ${seats.length} seats`
              : 'Net chips across the session'
          }
        />
        <Stat
          label={multi ? 'Table W / L / P' : 'W / L / P'}
          value={`${total((p) => p.handsWon)} / ${total((p) => p.handsLost)} / ${total((p) => p.handsPushed)}`}
          title={`Hands won, lost and pushed${multi ? ', added up across every seat' : ''}`}
        />
        <Stat
          label="Blackjacks"
          value={String(total((p) => p.blackjacks))}
          title={`Naturals dealt${multi ? ' to any seat' : ''}`}
        />
        <Stat
          label="Busts"
          value={String(total((p) => p.busts))}
          title={`Hands busted${multi ? ' by any seat' : ''}`}
        />
        <Stat
          label="Shoe"
          value={`${state.shoeRemaining} cards`}
          title="Cards left before the shoe is reshuffled — one shoe serves the whole table"
        />
      </div>
    </div>
  )
}

function insuranceText(seat: BlackjackPlayer, phase: BlackjackState['phase']): string | null {
  if (seat.insuranceBet > 0) {
    return (
      `Insurance ${seat.insuranceBet}` +
      (seat.insuranceOutcome === 'won'
        ? ` · pays ${seat.insuranceBet * 2}`
        : seat.insuranceOutcome === 'lost'
          ? ' · lost'
          : '')
    )
  }
  if (seat.insuranceOutcome === 'declined') return 'Insurance declined'
  if (phase === 'insurance' && seat.insuranceOffer > 0) return 'Insurance offered…'
  return null
}

function SeatBox({
  seat,
  size,
  acting,
  thinking,
  phase
}: {
  seat: BlackjackPlayer
  size: CardSize
  acting: boolean
  thinking: boolean
  phase: BlackjackState['phase']
}): React.JSX.Element {
  const classes = ['bj-seat']
  if (seat.hands.length > 1) classes.push('bj-seat-split')
  if (acting || thinking) classes.push('bj-seat-acting')
  if (seat.busted) classes.push('bj-seat-out')
  if (phase === 'settled' && seat.lastRoundNet > 0) classes.push('bj-seat-winner')

  const insurance = insuranceText(seat, phase)
  // A split seat claims width in proportion to its hands, so its hands sit side
  // by side wherever the row can afford it. At a full six they still stack —
  // there is no width for two boxes — but the growth is bounded, because four
  // hands claim four units and then wrap two-by-two rather than four deep.
  const hands = Math.max(1, seat.hands.length)

  return (
    <div className={classes.join(' ')} style={{ flexGrow: hands, maxWidth: `${260 * hands}px` }}>
      <div className="bj-hands">
        {seat.hands.length === 0 ? (
          <div className="bj-idle">{seat.busted ? 'out of chips' : 'waiting'}</div>
        ) : (
          seat.hands.map((hand, index) => (
            <HandBox
              key={hand.id}
              hand={hand}
              size={size}
              active={acting && index === seat.activeHandIndex}
              multi={seat.hands.length > 1}
              index={index}
            />
          ))
        )}
      </div>

      {insurance && (
        <div className={`insurance-chip insurance-${seat.insuranceOutcome ?? 'pending'}`}>
          {insurance}
        </div>
      )}

      <div className="seat-label">
        {/* The name needs its own element: text-overflow does not apply to a
            flex container, so putting it directly here clips long names
            mid-character instead of ellipsising them. */}
        <span className={`seat-name${thinking ? ' seat-thinking' : ''}`}>
          <span className="seat-name-text">{seat.name}</span>
          {thinking && <span className="dots"><i /><i /><i /></span>}
        </span>
      </div>
      <div className="bj-seat-meta">
        <span className="seat-chip seat-chip-gold">{seat.bankroll}</span>
        {seat.sessionNet !== 0 && (
          <span className={`bj-net ${seat.sessionNet > 0 ? 'stat-good' : 'stat-bad'}`}>
            {seat.sessionNet > 0 ? '+' : ''}
            {seat.sessionNet}
          </span>
        )}
      </div>
      <div className="seat-model">{seat.modelId}</div>
    </div>
  )
}

function HandBox({
  hand,
  size,
  active,
  multi,
  index
}: {
  hand: BlackjackHand
  size: CardSize
  active: boolean
  multi: boolean
  index: number
}): React.JSX.Element {
  const classes = ['hand-box']
  if (active) classes.push('hand-active')
  if (hand.status === 'busted') classes.push('hand-busted')
  if (hand.outcome) classes.push(`hand-${hand.outcome}`)

  return (
    <div className={classes.join(' ')}>
      {multi && <div className="hand-index">Hand {index + 1}</div>}
      <CardRow cards={hand.cards} size={size} />
      <div className="hand-meta">
        <span className="hand-total">{describeValue(hand.cards)}</span>
        <span className="hand-bet">bet {hand.bet}</span>
        {hand.outcome && (
          <span className={`hand-outcome outcome-${hand.outcome}`}>
            {OUTCOME_LABEL[hand.outcome]}
            {typeof hand.net === 'number' && hand.net !== 0 && (
              <> {hand.net > 0 ? '+' : ''}{hand.net}</>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

function Stat({
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
