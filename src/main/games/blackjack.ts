import { Shoe, type Card } from '../../shared/cards.ts'
import { describeValue, handValue } from '../../shared/blackjackValue.ts'
import type {
  BlackjackAction,
  BlackjackHand,
  BlackjackRules,
  BlackjackState
} from '../../shared/types.ts'

export { describeValue, handValue }
export type { HandValue } from '../../shared/blackjackValue.ts'

/** Chips settle to the half, so 3:2 payouts never leave float dust behind. */
function chips(value: number): number {
  return Math.round(value * 100) / 100
}

function isNaturalBlackjack(hand: BlackjackHand): boolean {
  return hand.splitDepth === 0 && hand.cards.length === 2 && handValue(hand.cards).total === 21
}

let handSeq = 0

export class BlackjackTable {
  readonly state: BlackjackState
  private readonly shoe: Shoe

  constructor(private readonly rules: BlackjackRules) {
    this.shoe = new Shoe(rules.deckCount)
    this.state = {
      phase: 'idle',
      roundNumber: 0,
      bankroll: rules.startingBankroll,
      baseBet: rules.baseBet,
      shoeRemaining: this.shoe.remaining,
      shoeJustShuffled: false,
      hands: [],
      activeHandIndex: 0,
      dealerCards: [],
      dealerHoleHidden: true,
      insuranceOffered: false,
      insuranceBet: 0,
      sessionNet: 0,
      lastRoundNet: 0,
      roundsPlayed: 0,
      handsWon: 0,
      handsLost: 0,
      handsPushed: 0,
      blackjacks: 0,
      busts: 0
    }
  }

  /** True when the player can no longer cover the base bet. */
  get isBroke(): boolean {
    return this.state.bankroll < this.state.baseBet
  }

  private newHand(bet: number, cards: Card[], splitDepth: number, fromSplitAces: boolean): BlackjackHand {
    return {
      id: `h${++handSeq}`,
      cards,
      bet,
      status: 'active',
      fromSplitAces,
      splitDepth
    }
  }

  /**
   * Changes the stake. Takes effect from the next round, never mid-hand, so a
   * hand already dealt always settles at the amount it was wagered for.
   */
  setBaseBet(amount: number): void {
    this.state.baseBet = Math.max(1, Math.round(amount))
  }

  /** The band a self-sizing model may wager, given the current bankroll. */
  betLimits(): { min: number; max: number } {
    const min = Math.min(this.state.baseBet, this.state.bankroll)
    return { min, max: Math.max(min, this.state.bankroll) }
  }

  /**
   * Deals a fresh round. Returns true if the round is already resolved (a
   * natural on either side), meaning no player decisions are needed.
   *
   * `wager` overrides the standing stake for this round only; it is clamped to
   * what the bankroll can actually cover.
   *
   * When the dealer shows an ace the round pauses in the `insurance` phase
   * instead: call `resolveInsurance` once the side bet has been decided.
   */
  startRound(wager?: number): boolean {
    const s = this.state
    s.shoeJustShuffled = this.shoe.reshuffleIfNeeded()
    s.roundNumber++
    s.phase = 'dealing'
    s.lastRoundNet = 0
    s.dealerHoleHidden = true
    s.activeHandIndex = 0
    s.insuranceOffered = false
    s.insuranceBet = 0
    s.insuranceOutcome = undefined

    const desired = wager === undefined ? s.baseBet : Math.round(wager)
    const bet = Math.max(1, Math.min(desired, s.bankroll))
    s.bankroll = Math.round((s.bankroll - bet) * 100) / 100

    const playerCards = [this.shoe.draw()]
    s.dealerCards = [this.shoe.draw()]
    playerCards.push(this.shoe.draw())
    s.dealerCards.push(this.shoe.draw())

    s.hands = [this.newHand(bet, playerCards, 0, false)]
    s.shoeRemaining = this.shoe.remaining

    // An ace up means insurance is offered before the dealer peeks underneath.
    if (this.rules.offerInsurance && s.dealerCards[0].rank === 14 && s.bankroll >= this.insuranceCost) {
      s.insuranceOffered = true
      s.phase = 'insurance'
      return false
    }

    return this.resolveNaturals()
  }

  /** Half the original stake, the standard insurance price. */
  get insuranceCost(): number {
    const bet = this.state.hands[0]?.bet ?? this.state.baseBet
    return Math.round((bet / 2) * 100) / 100
  }

  get awaitingInsurance(): boolean {
    return this.state.phase === 'insurance'
  }

  /**
   * Settles the insurance offer and lets the dealer peek. Returns true when the
   * round is already decided by a natural and needs no player decisions.
   */
  resolveInsurance(take: boolean): boolean {
    const s = this.state
    if (s.phase !== 'insurance') throw new Error('insurance is not on offer')

    if (take) {
      const cost = this.insuranceCost
      s.insuranceBet = cost
      s.bankroll = chips(s.bankroll - cost)
    } else {
      s.insuranceOutcome = 'declined'
    }
    return this.resolveNaturals()
  }

  /** The dealer peeks; a natural on either side ends the round immediately. */
  private resolveNaturals(): boolean {
    const s = this.state
    const playerNatural = isNaturalBlackjack(s.hands[0])
    const dealerNatural = handValue(s.dealerCards).total === 21

    if (playerNatural || dealerNatural) {
      if (playerNatural) s.hands[0].status = 'blackjack'
      s.phase = 'dealer'
      return true
    }

    s.phase = 'player'
    return false
  }

  get activeHand(): BlackjackHand | undefined {
    return this.state.hands[this.state.activeHandIndex]
  }

  legalActions(): BlackjackAction[] {
    const hand = this.activeHand
    if (!hand || hand.status !== 'active') return []
    const actions: BlackjackAction[] = ['hit', 'stand']
    const isFirstDecision = hand.cards.length === 2
    const canAffordAnotherBet = this.state.bankroll >= hand.bet

    if (isFirstDecision && canAffordAnotherBet) {
      const allowedAfterSplit = hand.splitDepth === 0 || this.rules.doubleAfterSplit
      if (allowedAfterSplit) actions.push('double')

      const pair = hand.cards[0].rank === hand.cards[1].rank
      const splitsSoFar = this.state.hands.length - 1
      if (pair && splitsSoFar < this.rules.maxSplits) actions.push('split')
    }
    return actions
  }

  /** Applies a legal player action. Returns a short label for the log. */
  applyAction(action: BlackjackAction): string {
    const s = this.state
    const hand = this.activeHand
    if (!hand) throw new Error('no active hand')
    if (!this.legalActions().includes(action)) {
      throw new Error(`illegal blackjack action: ${action}`)
    }

    let label = action as string

    switch (action) {
      case 'hit': {
        const card = this.shoe.draw()
        hand.cards.push(card)
        const { total } = handValue(hand.cards)
        if (total > 21) hand.status = 'busted'
        else if (total === 21) hand.status = 'stood'
        label = 'hits'
        break
      }
      case 'stand': {
        hand.status = 'stood'
        label = 'stands'
        break
      }
      case 'double': {
        s.bankroll -= hand.bet
        hand.bet *= 2
        hand.cards.push(this.shoe.draw())
        hand.status = handValue(hand.cards).total > 21 ? 'busted' : 'doubled'
        label = 'doubles down'
        break
      }
      case 'split': {
        const moved = hand.cards.pop() as Card
        const splitAces = hand.cards[0].rank === 14
        const bet = hand.bet
        s.bankroll -= bet

        hand.splitDepth++
        hand.fromSplitAces = splitAces
        hand.cards.push(this.shoe.draw())

        const sibling = this.newHand(bet, [moved, this.shoe.draw()], hand.splitDepth, splitAces)
        s.hands.splice(s.activeHandIndex + 1, 0, sibling)

        if (splitAces) {
          // One card only on split aces; both hands are immediately done.
          hand.status = 'stood'
          sibling.status = 'stood'
        } else {
          if (handValue(hand.cards).total === 21) hand.status = 'stood'
          if (handValue(sibling.cards).total === 21) sibling.status = 'stood'
        }
        label = 'splits'
        break
      }
    }

    s.shoeRemaining = this.shoe.remaining
    this.advanceToNextActiveHand()
    return label
  }

  private advanceToNextActiveHand(): void {
    const s = this.state
    while (s.activeHandIndex < s.hands.length && s.hands[s.activeHandIndex].status !== 'active') {
      s.activeHandIndex++
    }
    if (s.activeHandIndex >= s.hands.length) {
      s.activeHandIndex = Math.max(0, s.hands.length - 1)
      s.phase = 'dealer'
    }
  }

  get awaitingPlayer(): boolean {
    return this.state.phase === 'player' && this.activeHand?.status === 'active'
  }

  /** Reveals the hole card and draws for the dealer. Returns cards drawn. */
  playDealerTurn(): Card[] {
    const s = this.state
    s.dealerHoleHidden = false
    const drawn: Card[] = []

    const everyHandDone = s.hands.every((h) => h.status === 'busted' || h.status === 'blackjack')
    if (everyHandDone) {
      s.phase = 'settled'
      return drawn
    }

    for (;;) {
      const { total, soft } = handValue(s.dealerCards)
      const mustHit = total < 17 || (total === 17 && soft && this.rules.dealerHitsSoft17)
      if (!mustHit) break
      const card = this.shoe.draw()
      s.dealerCards.push(card)
      drawn.push(card)
    }
    s.shoeRemaining = this.shoe.remaining
    s.phase = 'settled'
    return drawn
  }

  /** Scores every hand, pays out, and updates session counters. */
  settle(): void {
    const s = this.state
    const dealer = handValue(s.dealerCards).total
    const dealerNatural = s.dealerCards.length === 2 && dealer === 21
    const dealerBust = dealer > 21
    let roundNet = 0

    // Insurance settles first, independently of how the hand itself plays out.
    if (s.insuranceBet > 0) {
      if (dealerNatural) {
        // Pays 2:1, so the stake plus twice the stake comes back.
        s.insuranceOutcome = 'won'
        const credit = chips(s.insuranceBet * 3)
        s.bankroll = chips(s.bankroll + credit)
        roundNet = chips(roundNet + (credit - s.insuranceBet))
      } else {
        s.insuranceOutcome = 'lost'
        roundNet = chips(roundNet - s.insuranceBet)
      }
    }

    for (const hand of s.hands) {
      const player = handValue(hand.cards).total
      let credit = 0

      if (hand.status === 'blackjack') {
        if (dealerNatural) {
          hand.outcome = 'push'
          credit = hand.bet
        } else {
          hand.outcome = 'blackjack'
          credit = hand.bet * (1 + this.rules.blackjackPayout)
        }
      } else if (hand.status === 'busted') {
        hand.outcome = 'lose'
      } else if (dealerNatural) {
        hand.outcome = 'lose'
      } else if (dealerBust || player > dealer) {
        hand.outcome = 'win'
        credit = hand.bet * 2
      } else if (player === dealer) {
        hand.outcome = 'push'
        credit = hand.bet
      } else {
        hand.outcome = 'lose'
      }

      credit = chips(credit)
      hand.net = chips(credit - hand.bet)
      roundNet = chips(roundNet + hand.net)
      s.bankroll = chips(s.bankroll + credit)

      if (hand.outcome === 'blackjack') {
        s.blackjacks++
        s.handsWon++
      } else if (hand.outcome === 'win') s.handsWon++
      else if (hand.outcome === 'push') s.handsPushed++
      else s.handsLost++

      if (hand.status === 'busted') s.busts++
    }

    s.lastRoundNet = roundNet
    s.sessionNet = chips(s.sessionNet + roundNet)
    s.roundsPlayed++
    s.phase = 'settled'
  }
}
