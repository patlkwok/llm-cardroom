import { Shoe, type Card } from '../../shared/cards.ts'
import { describeValue, handValue } from '../../shared/blackjackValue.ts'
import { GAMES } from '../../shared/types.ts'
import type {
  BlackjackAction,
  BlackjackHand,
  BlackjackPlayer,
  BlackjackRules,
  BlackjackState
} from '../../shared/types.ts'

export { describeValue, handValue }
export type { HandValue } from '../../shared/blackjackValue.ts'

export const MAX_BLACKJACK_SEATS = GAMES.blackjack.maxPlayers

/** Chips settle to the half, so 3:2 payouts never leave float dust behind. */
function chips(value: number): number {
  return Math.round(value * 100) / 100
}

function isNaturalBlackjack(hand: BlackjackHand): boolean {
  return hand.splitDepth === 0 && hand.cards.length === 2 && handValue(hand.cards).total === 21
}

let handSeq = 0

export interface BlackjackSeed {
  id: string
  name: string
  modelId: string
}

/**
 * Several models against one dealer, sharing one shoe.
 *
 * The shared shoe is the point: seats face the same dealer upcards in the same
 * rounds, which makes comparing them a paired measurement rather than two
 * unrelated sessions. It also puts every other seat's cards on the table face
 * up, which is what the prompts show.
 */
export class BlackjackTable {
  readonly state: BlackjackState
  private readonly shoe: Shoe
  /** Seat ids still owed an insurance decision this round, in seat order. */
  private insuranceQueue: string[] = []

  constructor(private readonly rules: BlackjackRules, seeds: BlackjackSeed[]) {
    if (seeds.length > MAX_BLACKJACK_SEATS) {
      throw new Error(`blackjack seats at most ${MAX_BLACKJACK_SEATS} players, got ${seeds.length}`)
    }
    this.shoe = new Shoe(rules.deckCount)
    this.state = {
      phase: 'idle',
      roundNumber: 0,
      baseBet: rules.baseBet,
      shoeRemaining: this.shoe.remaining,
      shoeJustShuffled: false,
      players: seeds.map((seed, index) => this.blankPlayer(seed, index, rules.startingBankroll)),
      activePlayerIndex: -1,
      dealerCards: [],
      dealerHoleHidden: true,
      insuranceOffered: false,
      roundsPlayed: 0
    }
  }

  private blankPlayer(seed: BlackjackSeed, index: number, bankroll: number): BlackjackPlayer {
    return {
      id: seed.id,
      name: seed.name,
      modelId: seed.modelId,
      seatIndex: index,
      bankroll: chips(bankroll),
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
    }
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

  /* --------------------------------------------------------------- roster */

  /** Seats that still have chips enough to be dealt in. */
  get activePlayers(): BlackjackPlayer[] {
    return this.state.players.filter((player) => !player.busted)
  }

  /** True when nobody left at the table can cover the table minimum. */
  get isTableBroke(): boolean {
    return this.activePlayers.length === 0
  }

  player(id: string): BlackjackPlayer | undefined {
    return this.state.players.find((p) => p.id === id)
  }

  /**
   * Seats a new player between rounds. Their bankroll is new money arriving at
   * the table, not taken from anyone.
   */
  addPlayer(seed: BlackjackSeed, bankroll: number): void {
    const s = this.state
    if (s.players.length >= MAX_BLACKJACK_SEATS) {
      throw new Error(`The table is full at ${MAX_BLACKJACK_SEATS} seats.`)
    }
    if (s.players.some((p) => p.id === seed.id)) return
    s.players.push(this.blankPlayer(seed, s.players.length, Math.max(1, Math.round(bankroll))))
  }

  /** Removes a player between rounds; their chips leave with them. */
  removePlayer(id: string): boolean {
    const s = this.state
    const index = s.players.findIndex((p) => p.id === id)
    if (index === -1) return false
    s.players.splice(index, 1)
    // Seat indices are positional, so renumber to keep them dense.
    s.players.forEach((player, i) => {
      player.seatIndex = i
    })
    s.activePlayerIndex = -1
    return true
  }

  /**
   * Changes the stake. Takes effect from the next round, never mid-hand, so a
   * hand already dealt always settles at the amount it was wagered for.
   */
  setBaseBet(amount: number): void {
    this.state.baseBet = Math.max(1, Math.round(amount))
  }

  /**
   * Marks anyone who can no longer cover the table minimum as out, and returns
   * only those newly retired. Reporting the transition rather than the state is
   * what keeps the log from re-announcing the same seat every round.
   */
  retireBrokePlayers(): BlackjackPlayer[] {
    const retired: BlackjackPlayer[] = []
    for (const player of this.state.players) {
      if (player.busted || player.bankroll >= this.state.baseBet) continue
      player.busted = true
      retired.push(player)
    }
    return retired
  }

  /** The band a self-sizing model may wager, given its own bankroll. */
  betLimits(player: BlackjackPlayer): { min: number; max: number } {
    const min = Math.min(this.state.baseBet, player.bankroll)
    return { min, max: Math.max(min, player.bankroll) }
  }

  /* ----------------------------------------------------------------- deal */

  /**
   * Deals a fresh round to every seat that can afford it. Returns true if the
   * round is already resolved — a dealer natural, or nothing but naturals and
   * busts — meaning no player decisions are needed.
   *
   * `wagers` overrides the standing stake per seat for this round only; each is
   * clamped to what that bankroll can actually cover.
   *
   * When the dealer shows an ace the round pauses in the `insurance` phase
   * instead: work through `insuranceSeat` and then call `closeInsurance`.
   */
  startRound(wagers: Record<string, number> = {}): boolean {
    const s = this.state
    this.retireBrokePlayers()
    s.shoeJustShuffled = this.shoe.reshuffleIfNeeded()
    s.roundNumber++
    s.phase = 'dealing'
    s.dealerHoleHidden = true
    s.activePlayerIndex = -1
    s.insuranceOffered = false
    s.dealerCards = []
    this.insuranceQueue = []

    for (const player of s.players) {
      player.hands = []
      player.activeHandIndex = 0
      player.lastRoundNet = 0
      player.insuranceOffer = 0
      player.insuranceBet = 0
      player.insuranceOutcome = undefined
    }

    const dealtIn = this.activePlayers
    if (dealtIn.length === 0) {
      s.phase = 'settled'
      return true
    }

    for (const player of dealtIn) {
      const desired = wagers[player.id] === undefined ? s.baseBet : Math.round(wagers[player.id])
      const bet = Math.max(1, Math.min(desired, player.bankroll))
      player.bankroll = chips(player.bankroll - bet)
      player.hands = [this.newHand(bet, [], 0, false)]
    }

    // One card at a time round the table, then one to the dealer, twice over —
    // the order a real shoe game deals in, and the order the burn rate assumes.
    for (let pass = 0; pass < 2; pass++) {
      for (const player of dealtIn) player.hands[0].cards.push(this.shoe.draw())
      s.dealerCards.push(this.shoe.draw())
    }
    s.shoeRemaining = this.shoe.remaining

    // An ace up means insurance is offered before the dealer peeks underneath.
    // It is offered seat by seat, and only to seats that can pay for it.
    if (this.rules.offerInsurance && s.dealerCards[0].rank === 14) {
      for (const player of dealtIn) {
        const cost = insuranceCost(player)
        if (player.bankroll < cost) continue
        player.insuranceOffer = cost
        this.insuranceQueue.push(player.id)
      }
      if (this.insuranceQueue.length > 0) {
        s.insuranceOffered = true
        s.phase = 'insurance'
        return false
      }
    }

    return this.resolveNaturals()
  }

  /* ------------------------------------------------------------ insurance */

  get awaitingInsurance(): boolean {
    return this.state.phase === 'insurance'
  }

  /** The next seat owed an insurance decision, or undefined when all have answered. */
  get insuranceSeat(): BlackjackPlayer | undefined {
    const id = this.insuranceQueue[0]
    return id === undefined ? undefined : this.player(id)
  }

  /** Records one seat's answer to the insurance offer. */
  takeInsurance(playerId: string, take: boolean): void {
    const s = this.state
    if (s.phase !== 'insurance') throw new Error('insurance is not on offer')
    const index = this.insuranceQueue.indexOf(playerId)
    if (index === -1) throw new Error(`${playerId} was not offered insurance`)
    this.insuranceQueue.splice(index, 1)

    const player = this.player(playerId)
    if (!player) return
    if (take) {
      const cost = player.insuranceOffer
      player.insuranceBet = cost
      player.bankroll = chips(player.bankroll - cost)
    } else {
      player.insuranceOutcome = 'declined'
    }
  }

  /**
   * Closes the offer and lets the dealer peek. Returns true when the round is
   * already decided and needs no player decisions.
   */
  closeInsurance(): boolean {
    if (this.state.phase !== 'insurance') throw new Error('insurance is not on offer')
    // Anyone left unanswered is treated as declining, so a stopped match still
    // leaves the table in a consistent state.
    for (const id of [...this.insuranceQueue]) this.takeInsurance(id, false)
    return this.resolveNaturals()
  }

  /** The dealer peeks; a dealer natural ends the round for everyone at once. */
  private resolveNaturals(): boolean {
    const s = this.state
    const dealerNatural = handValue(s.dealerCards).total === 21

    for (const player of s.players) {
      const hand = player.hands[0]
      if (hand && isNaturalBlackjack(hand)) hand.status = 'blackjack'
    }

    if (dealerNatural) {
      s.phase = 'dealer'
      s.activePlayerIndex = -1
      return true
    }

    s.phase = 'player'
    s.activePlayerIndex = 0
    this.advanceToNextActor()
    return s.phase !== 'player'
  }

  /* --------------------------------------------------------- player turns */

  get activePlayer(): BlackjackPlayer | undefined {
    const index = this.state.activePlayerIndex
    return index >= 0 ? this.state.players[index] : undefined
  }

  get activeHand(): BlackjackHand | undefined {
    const player = this.activePlayer
    return player?.hands[player.activeHandIndex]
  }

  get awaitingPlayer(): boolean {
    return this.state.phase === 'player' && this.activeHand?.status === 'active'
  }

  legalActions(): BlackjackAction[] {
    const player = this.activePlayer
    const hand = this.activeHand
    if (!player || !hand || hand.status !== 'active') return []
    const actions: BlackjackAction[] = ['hit', 'stand']
    const isFirstDecision = hand.cards.length === 2
    const canAffordAnotherBet = player.bankroll >= hand.bet

    if (isFirstDecision && canAffordAnotherBet) {
      const allowedAfterSplit = hand.splitDepth === 0 || this.rules.doubleAfterSplit
      if (allowedAfterSplit) actions.push('double')

      const pair = hand.cards[0].rank === hand.cards[1].rank
      const splitsSoFar = player.hands.length - 1
      if (pair && splitsSoFar < this.rules.maxSplits) actions.push('split')
    }
    return actions
  }

  /** Applies a legal action for the acting seat. Returns a short label for the log. */
  applyAction(action: BlackjackAction): string {
    const player = this.activePlayer
    const hand = this.activeHand
    if (!player || !hand) throw new Error('no active hand')
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
        // Matching the original stake: startRound already took the first one,
        // so the hand now risks two and hand.bet reflects the total at stake.
        player.bankroll = chips(player.bankroll - hand.bet)
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
        player.bankroll = chips(player.bankroll - bet)

        hand.splitDepth++
        hand.fromSplitAces = splitAces
        hand.cards.push(this.shoe.draw())

        const sibling = this.newHand(bet, [moved, this.shoe.draw()], hand.splitDepth, splitAces)
        player.hands.splice(player.activeHandIndex + 1, 0, sibling)

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

    this.state.shoeRemaining = this.shoe.remaining
    this.advanceToNextActor()
    return label
  }

  /**
   * Walks to the next hand owed a decision: the rest of this seat's splits
   * first, then on round the table. The dealer plays once everyone is done.
   */
  private advanceToNextActor(): void {
    const s = this.state
    if (s.phase !== 'player') return

    while (s.activePlayerIndex >= 0 && s.activePlayerIndex < s.players.length) {
      const player = s.players[s.activePlayerIndex]
      while (
        player.activeHandIndex < player.hands.length &&
        player.hands[player.activeHandIndex].status !== 'active'
      ) {
        player.activeHandIndex++
      }
      if (player.activeHandIndex < player.hands.length) return
      player.activeHandIndex = Math.max(0, player.hands.length - 1)
      s.activePlayerIndex++
    }

    s.activePlayerIndex = -1
    s.phase = 'dealer'
  }

  /* --------------------------------------------------------------- dealer */

  /** Reveals the hole card and draws for the dealer. Returns cards drawn. */
  playDealerTurn(): Card[] {
    const s = this.state
    s.dealerHoleHidden = false
    s.activePlayerIndex = -1
    const drawn: Card[] = []

    // The dealer only draws when some hand can still be beaten.
    const liveHand = s.players.some((player) =>
      player.hands.some((hand) => hand.status !== 'busted' && hand.status !== 'blackjack')
    )
    if (!liveHand) {
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

  /** Scores every seat against the dealer's single total and pays out. */
  settle(): void {
    const s = this.state
    const dealer = handValue(s.dealerCards).total
    const dealerNatural = s.dealerCards.length === 2 && dealer === 21
    const dealerBust = dealer > 21

    for (const player of s.players) {
      if (player.hands.length === 0 && player.insuranceBet === 0) continue
      let roundNet = 0

      // Insurance settles first, independently of how the hand itself plays out.
      if (player.insuranceBet > 0) {
        if (dealerNatural) {
          // Pays 2:1, so the stake plus twice the stake comes back.
          player.insuranceOutcome = 'won'
          const credit = chips(player.insuranceBet * 3)
          player.bankroll = chips(player.bankroll + credit)
          roundNet = chips(roundNet + (credit - player.insuranceBet))
        } else {
          player.insuranceOutcome = 'lost'
          roundNet = chips(roundNet - player.insuranceBet)
        }
      }

      for (const hand of player.hands) {
        const total = handValue(hand.cards).total
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
        } else if (dealerBust || total > dealer) {
          hand.outcome = 'win'
          credit = hand.bet * 2
        } else if (total === dealer) {
          hand.outcome = 'push'
          credit = hand.bet
        } else {
          hand.outcome = 'lose'
        }

        credit = chips(credit)
        hand.net = chips(credit - hand.bet)
        roundNet = chips(roundNet + hand.net)
        player.bankroll = chips(player.bankroll + credit)

        if (hand.outcome === 'blackjack') {
          player.blackjacks++
          player.handsWon++
        } else if (hand.outcome === 'win') player.handsWon++
        else if (hand.outcome === 'push') player.handsPushed++
        else player.handsLost++

        if (hand.status === 'busted') player.busts++
      }

      player.lastRoundNet = roundNet
      player.sessionNet = chips(player.sessionNet + roundNet)
      if (player.hands.length > 0) player.roundsPlayed++
    }

    s.roundsPlayed++
    s.phase = 'settled'
  }
}

/** Half the seat's original stake, the standard insurance price. */
export function insuranceCost(player: BlackjackPlayer): number {
  const bet = player.hands[0]?.bet ?? 0
  return Math.round((bet / 2) * 100) / 100
}
