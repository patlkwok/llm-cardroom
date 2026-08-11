import { describeValue, handValue } from '../../shared/blackjackValue.ts'
import type {
  BlackjackHand,
  BlackjackRules,
  BlackjackState,
  PlayerConfig
} from '../../shared/types.ts'
import { CardRow } from './PlayingCard.tsx'

interface Props {
  state: BlackjackState
  player?: PlayerConfig
  thinking: boolean
  rules: BlackjackRules
}

const OUTCOME_LABEL: Record<string, string> = {
  blackjack: 'Blackjack!',
  win: 'Win',
  push: 'Push',
  lose: 'Loss'
}

export function BlackjackView({ state, player, thinking, rules }: Props): React.JSX.Element {
  const dealerVisible = state.dealerHoleHidden ? state.dealerCards.slice(0, 1) : state.dealerCards
  const dealerTotal = state.dealerCards.length
    ? state.dealerHoleHidden
      ? `${handValue(dealerVisible).total} + ?`
      : describeValue(state.dealerCards)
    : '—'

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

      <div className="bj-player">
        <div className="bj-hands">
          {state.hands.length === 0 && (
            <div className="empty-hand">Waiting for the first deal…</div>
          )}
          {state.hands.map((hand, index) => (
            <HandBox
              key={hand.id}
              hand={hand}
              active={state.phase === 'player' && index === state.activeHandIndex}
              multi={state.hands.length > 1}
              index={index}
            />
          ))}
        </div>

        {(state.insuranceOffered || state.insuranceBet > 0) && (
          <div className={`insurance-chip insurance-${state.insuranceOutcome ?? 'pending'}`}>
            {state.phase === 'insurance'
              ? 'Insurance offered…'
              : state.insuranceBet > 0
                ? `Insurance ${state.insuranceBet}` +
                  (state.insuranceOutcome === 'won'
                    ? ` · pays ${state.insuranceBet * 2}`
                    : state.insuranceOutcome === 'lost'
                      ? ' · lost'
                      : '')
                : 'Insurance declined'}
          </div>
        )}

        <div className="seat-label seat-label-player">
          <span className={`seat-name${thinking ? ' seat-thinking' : ''}`}>
            {player?.name ?? 'No model seated'}
            {thinking && <span className="dots"><i /><i /><i /></span>}
          </span>
          <span className="seat-chip seat-chip-gold">{state.bankroll} chips</span>
        </div>
        {player && <div className="seat-model">{player.modelId}</div>}
      </div>

      <div className="bj-stats">
        <Stat label="Round" value={String(state.roundNumber)} />
        <Stat
          label="Session"
          value={`${state.sessionNet >= 0 ? '+' : ''}${state.sessionNet}`}
          tone={state.sessionNet > 0 ? 'good' : state.sessionNet < 0 ? 'bad' : undefined}
        />
        <Stat label="W / L / P" value={`${state.handsWon} / ${state.handsLost} / ${state.handsPushed}`} />
        <Stat label="Blackjacks" value={String(state.blackjacks)} />
        <Stat label="Busts" value={String(state.busts)} />
        <Stat label="Shoe" value={`${state.shoeRemaining} cards`} />
      </div>
    </div>
  )
}

function HandBox({
  hand,
  active,
  multi,
  index
}: {
  hand: BlackjackHand
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
      <CardRow cards={hand.cards} size="lg" />
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
  tone
}: {
  label: string
  value: string
  tone?: 'good' | 'bad'
}): React.JSX.Element {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${tone ? ` stat-${tone}` : ''}`}>{value}</div>
    </div>
  )
}
