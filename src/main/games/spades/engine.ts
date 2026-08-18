import { cardCode, sameCard, type Card } from '../../../shared/cards.ts'
import { GAMES } from '../../../shared/types.ts'
import type {
  SpadesPlayer,
  SpadesRules,
  SpadesState,
  SpadesTeam,
  SpadesTrick
} from '../../../shared/types.ts'
import {
  dealHands,
  followSuit,
  leadableCards,
  removeCard,
  sortHand,
  trickWinner
} from '../tricks/core.ts'

export const SPADES_SEATS = GAMES.spades.minPlayers
export const CARDS_PER_HAND = 52 / SPADES_SEATS
export const TRICKS_PER_HAND = CARDS_PER_HAND
/** Spades are trump, always. There is no variant here worth a setting. */
export const TRUMP = 's' as const
/** Ten bags cost a hundred points and knock ten off the count. */
export const BAGS_PER_PENALTY = 10
export const BAG_PENALTY = 100
/** Bringing a nil home, or failing it. Symmetrical, and it is the big swing. */
export const NIL_VALUE = 100
/**
 * Both partners bidding nil and both bringing it home: the pair's nil bonuses
 * are doubled, so 2 x 100 doubled. Double nil is scored as one thing rather
 * than as two independent nils — see `scoreTeam`.
 */
export const DOUBLE_NIL_VALUE = 400
/** A nil declared before the seat saw a card is worth double an ordinary one. */
export const BLIND_NIL_VALUE = 200
/**
 * How far behind a partnership must be before it may bid blind. At 0-0 nobody
 * qualifies, so a blind nil can never happen in the first hand.
 */
export const BLIND_NIL_DEFICIT = 100

export interface SpadesSeed {
  id: string
  name: string
  modelId: string
}

/**
 * Spades, in the partnership form everyone means by the name.
 *
 * Every rule below is a decision rather than a lookup — variants genuinely
 * disagree about all of them — so they are settled here and stated in force in
 * the system prompt:
 *
 * - Partnerships are **positional**: seats 0 and 2 against seats 1 and 3. That
 *   is only safe because the roster is fixed for the match; a seat renumbering
 *   would swap somebody's partner for an opponent halfway through.
 * - A bid of **0 is nil**, worth ±100 to the partnership on its own. Blind nil
 *   is not offered, the way surrender is not offered at blackjack.
 * - **Double nil — both partners on nil — is scored as one thing, not two.**
 *   Both bringing it home doubles the pair's nil bonuses (400); either of them
 *   failing carries no nil penalty at all. Scoring it as two independent nils
 *   is wrong in both directions, and was wrong here at first.
 * - **A team's tricks all count together by default**, the nil bidder's
 *   included, so a trick a nil bidder is forced to take breaks the nil *and*
 *   counts towards the partner's contract. `nilTricksCountToContract` turns
 *   that off for tables that play the harsher house rule. Either way every
 *   trick belongs to a partnership, so `team0.tricksWon + team1.tricksWon
 *   === 13` holds — that is the conservation invariant this engine is tested
 *   against, and it is deliberately independent of the setting.
 * - Making the contract scores 10 a trick plus **1 per overtrick (a bag)**;
 *   failing scores −10 a trick and no bags at all.
 * - Ten accumulated bags cost 100 points and drop the count by ten. Bags are
 *   the only score here that carries *between* hands as a penalty.
 * - Spades may not be **led** until one has been played on some earlier trick,
 *   unless spades are all a seat holds.
 * - There is no special opening card; the seat left of the dealer leads.
 */
export class SpadesTable {
  readonly state: SpadesState
  /** Seats still owed a blind-nil offer this hand, in bidding order. */
  private blindQueue: number[] = []

  constructor(seeds: SpadesSeed[], private readonly rules: SpadesRules) {
    if (seeds.length !== SPADES_SEATS) {
      throw new Error(`spades needs exactly ${SPADES_SEATS} players, got ${seeds.length}`)
    }
    const players: SpadesPlayer[] = seeds.map((seed, index) => ({
      id: seed.id,
      name: seed.name,
      modelId: seed.modelId,
      seatIndex: index,
      teamIndex: index % 2,
      hand: [],
      bid: null,
      blindNil: false,
      tricksWon: 0,
      lastHandTricks: 0,
      nilsBid: 0,
      nilsMade: 0
    }))

    this.state = {
      kind: 'spades',
      phase: 'idle',
      handNumber: 0,
      handsPlayed: 0,
      players,
      teams: [makeTeam(0, players), makeTeam(1, players)],
      // Rotates before the first deal, so hand 1 is dealt by seat 0.
      dealerIndex: -1,
      biddingSeatIndex: -1,
      currentTrick: null,
      lastTrick: null,
      trickNumber: 0,
      leadSeatIndex: 0,
      actingSeatIndex: -1,
      spadesBroken: false,
      forcedPlays: 0,
      totalPlays: 0
    }
  }

  player(id: string): SpadesPlayer | undefined {
    return this.state.players.find((p) => p.id === id)
  }

  team(index: number): SpadesTeam {
    const team = this.state.teams[index]
    if (!team) throw new Error(`no such team: ${index}`)
    return team
  }

  teamOf(seatIndex: number): SpadesTeam {
    return this.team(this.state.players[seatIndex].teamIndex)
  }

  /** The seat two to the left: partnerships are positional and seats never move. */
  partnerIndex(seatIndex: number): number {
    return (seatIndex + 2) % SPADES_SEATS
  }

  partnerOf(seatIndex: number): SpadesPlayer {
    return this.state.players[this.partnerIndex(seatIndex)]
  }

  opponentsOf(seatIndex: number): SpadesPlayer[] {
    const team = this.state.players[seatIndex].teamIndex
    return this.state.players.filter((p) => p.teamIndex !== team)
  }

  /** Teams ordered by score, best (highest) first. */
  get standings(): SpadesTeam[] {
    return [...this.state.teams].sort((a, b) => b.score - a.score)
  }

  /**
   * The match ends when a partnership reaches the target, or when one falls
   * through the floor. Both are checked only between hands.
   */
  get isMatchOver(): boolean {
    const { targetScore, bustScore } = this.rules
    return this.state.teams.some(
      (team) => team.score >= targetScore || (bustScore < 0 && team.score <= bustScore)
    )
  }

  /**
   * Highest total takes it. Both partnerships passing the target in the same
   * hand is genuinely possible, and then the higher score wins; a dead level
   * tie names both, and the driver plays on rather than declaring one.
   */
  get winnerName(): string {
    const best = Math.max(...this.state.teams.map((t) => t.score))
    return this.state.teams
      .filter((t) => t.score === best)
      .map((t) => t.name)
      .join(' and ')
  }

  /** True when the target was passed but nobody is actually ahead. */
  get isDeadHeat(): boolean {
    const [a, b] = this.state.teams
    return a.score === b.score && a.score >= this.rules.targetScore
  }

  /* ------------------------------------------------------------ the deal */

  startHand(): void {
    const s = this.state
    s.handNumber++
    s.trickNumber = 0
    s.currentTrick = null
    s.lastTrick = null
    s.spadesBroken = false
    s.actingSeatIndex = -1
    s.lastHandSummary = undefined
    s.dealerIndex = (s.dealerIndex + 1) % SPADES_SEATS

    const hands = dealHands(SPADES_SEATS, CARDS_PER_HAND)
    s.players.forEach((player, index) => {
      player.hand = hands[index]
      player.bid = null
      player.blindNil = false
      player.tricksWon = 0
    })
    for (const team of s.teams) {
      team.contract = 0
      team.tricksWon = 0
      team.lastHandDelta = 0
    }

    s.leadSeatIndex = this.leftOfDealer()

    // A blind nil has to be declared before the seat has seen anything, so it
    // gets a round of its own ahead of the ordinary bidding. Skipped outright
    // when the rule is off or nobody is far enough behind — which includes
    // every first hand, since the scores start level.
    this.blindQueue = this.rules.blindNil ? this.seatsEligibleForBlindNil() : []
    if (this.blindQueue.length > 0) {
      s.phase = 'blindBidding'
      s.biddingSeatIndex = this.blindQueue[0]
    } else {
      // Bidding opens to the dealer's left and runs round the table, so every
      // seat but the first bids knowing something about its partner.
      s.phase = 'bidding'
      s.biddingSeatIndex = this.leftOfDealer()
    }
  }

  /**
   * Seats whose partnership is far enough behind to bid blind, in bidding
   * order. Eligibility is a partnership property, so both partners get the
   * offer or neither does.
   */
  private seatsEligibleForBlindNil(): number[] {
    const s = this.state
    const order: number[] = []
    for (let i = 0; i < SPADES_SEATS; i++) {
      const seatIndex = (this.leftOfDealer() + i) % SPADES_SEATS
      if (this.blindNilDeficit(seatIndex) >= BLIND_NIL_DEFICIT) order.push(seatIndex)
    }
    return order
  }

  /** How far this seat's partnership is behind the other one; negative if ahead. */
  blindNilDeficit(seatIndex: number): number {
    const mine = this.teamOf(seatIndex)
    const theirs = this.state.teams.find((t) => t.index !== mine.index)
    return (theirs?.score ?? 0) - mine.score
  }

  get blindBidding(): boolean {
    return this.state.phase === 'blindBidding'
  }

  /** The seat owed a blind-nil offer, or undefined once all have answered. */
  get pendingBlindSeat(): SpadesPlayer | undefined {
    const index = this.blindQueue[0]
    return index === undefined ? undefined : this.state.players[index]
  }

  /**
   * Answers the blind offer for one seat. Declaring commits it to a nil worth
   * double, taken **without having seen a card**; declining simply drops it
   * into the ordinary bidding round with everybody else.
   */
  setBlindNil(seatIndex: number, declare: boolean): void {
    const s = this.state
    if (s.phase !== 'blindBidding') throw new Error('no blind bidding is in progress')
    if (this.blindQueue[0] !== seatIndex) {
      throw new Error(`seat ${seatIndex} cannot answer the blind offer out of turn`)
    }
    if (declare) {
      const player = s.players[seatIndex]
      player.bid = 0
      player.blindNil = true
      player.nilsBid++
    }

    this.blindQueue.shift()
    if (this.blindQueue.length > 0) {
      s.biddingSeatIndex = this.blindQueue[0]
      return
    }

    // Everyone eligible has answered. Ordinary bidding starts from the dealer's
    // left, skipping anyone already committed to a blind nil.
    s.phase = 'bidding'
    const next = this.nextUnbidSeat(this.leftOfDealer())
    if (next === -1) this.closeBidding()
    else s.biddingSeatIndex = next
  }

  /** The first seat from `from` onwards that still owes a bid, or -1. */
  private nextUnbidSeat(from: number): number {
    const s = this.state
    for (let i = 0; i < SPADES_SEATS; i++) {
      const seatIndex = (from + i) % SPADES_SEATS
      if (s.players[seatIndex].bid === null) return seatIndex
    }
    return -1
  }

  private leftOfDealer(): number {
    return (this.state.dealerIndex + 1) % SPADES_SEATS
  }

  /* --------------------------------------------------------- the bidding */

  get bidding(): boolean {
    return this.state.phase === 'bidding'
  }

  /** The seat owed a bid, or undefined once all four are in. */
  get pendingBidSeat(): SpadesPlayer | undefined {
    const index = this.state.biddingSeatIndex
    return index >= 0 ? this.state.players[index] : undefined
  }

  /** Bids already made this hand, in the order they were made. */
  get bidsSoFar(): SpadesPlayer[] {
    const s = this.state
    const order: SpadesPlayer[] = []
    for (let i = 0; i < SPADES_SEATS; i++) {
      const player = s.players[(this.leftOfDealer() + i) % SPADES_SEATS]
      if (player.bid !== null) order.push(player)
    }
    return order
  }

  /**
   * Records one seat's bid and moves the bidding on. Bids do not have to add up
   * to thirteen — under- and over-bidding the hand are both ordinary.
   */
  setBid(seatIndex: number, bid: number): void {
    const s = this.state
    if (s.phase !== 'bidding') throw new Error('no bidding is in progress')
    if (seatIndex !== s.biddingSeatIndex) {
      throw new Error(`seat ${seatIndex} cannot bid out of turn`)
    }
    if (!Number.isInteger(bid) || bid < 0 || bid > TRICKS_PER_HAND) {
      throw new Error(`a bid is a whole number of tricks from 0 to ${TRICKS_PER_HAND}, got ${bid}`)
    }

    const player = s.players[seatIndex]
    player.bid = bid
    if (bid === 0) player.nilsBid++

    // Step over anyone already committed to a blind nil rather than assuming
    // the next seat round is the next bidder: a blind nil sets `bid` early, and
    // treating that as "everybody has bid" would end the round two seats short.
    const next = this.nextUnbidSeat((seatIndex + 1) % SPADES_SEATS)
    if (next !== -1) {
      s.biddingSeatIndex = next
      return
    }
    this.closeBidding()
  }

  /** Fixes the contracts and leads the first trick. */
  private closeBidding(): void {
    const s = this.state
    // A nil adds nothing to the contract — it is scored on its own, and its
    // partner's bid has to stand up unaided.
    s.biddingSeatIndex = -1
    for (const team of s.teams) {
      team.contract = team.seatIndices.reduce((sum, i) => sum + (s.players[i].bid ?? 0), 0)
    }
    s.phase = 'playing'
    this.openTrick(this.leftOfDealer())
  }

  /* ---------------------------------------------------------- the tricks */

  private openTrick(leadSeatIndex: number): void {
    const s = this.state
    s.trickNumber++
    s.leadSeatIndex = leadSeatIndex
    s.actingSeatIndex = leadSeatIndex
    s.currentTrick = {
      number: s.trickNumber,
      // Set for real by the opening lead; nothing reads it before then.
      leadSuit: 'c',
      plays: []
    }
  }

  get awaitingPlay(): boolean {
    return this.state.phase === 'playing' && this.state.actingSeatIndex >= 0
  }

  get actingPlayer(): SpadesPlayer | undefined {
    const index = this.state.actingSeatIndex
    return index >= 0 ? this.state.players[index] : undefined
  }

  /**
   * Every card the acting seat may legally play.
   *
   * The load-bearing method, exactly as at Hearts: when it returns one card the
   * driver plays it without asking a model, which removes both a paid call and
   * a failure surface from a move that was never in doubt.
   */
  legalPlays(seatIndex: number): Card[] {
    const s = this.state
    const player = s.players[seatIndex]
    if (!player || s.phase !== 'playing') return []
    const trick = s.currentTrick
    if (!trick) return []

    if (trick.plays.length === 0) {
      // Spades may not be led until one has been played. A seat holding nothing
      // else leads them anyway — the same rule, and the same escape, as hearts
      // at Hearts, which is why it lives in the shared module.
      return leadableCards(player.hand, TRUMP, s.spadesBroken)
    }

    const followers = followSuit(player.hand, trick.leadSuit)
    if (followers.length > 0) return followers

    // Void in the led suit: anything, trumps included. There is no equivalent
    // of the first-trick points rule here — nothing carries points at all.
    return [...player.hand]
  }

  /**
   * Plays one card for the acting seat. Rejects anything `legalPlays` does not
   * offer — the engine refuses an illegal card rather than trusting its callers.
   */
  playCard(seatIndex: number, card: Card, forced = false): void {
    const s = this.state
    if (s.phase !== 'playing') throw new Error('no hand is in progress')
    if (seatIndex !== s.actingSeatIndex) {
      throw new Error(`seat ${seatIndex} cannot play out of turn`)
    }
    const legal = this.legalPlays(seatIndex)
    if (!legal.some((c) => sameCard(c, card))) {
      throw new Error(`illegal play: ${cardCode(card)}`)
    }

    const player = s.players[seatIndex]
    const trick = s.currentTrick
    if (!trick) throw new Error('no trick is open')

    player.hand = removeCard(player.hand, card)
    if (trick.plays.length === 0) trick.leadSuit = card.suit
    trick.plays.push({ seatIndex, seatId: player.id, card })

    // Any spade played breaks them, a lead included. `leadableCards` only ever
    // offers a spade lead to a seat holding nothing else, so a spade on the
    // table always means trumps are genuinely in play — and the alternative
    // rule leaves the flag false while spades are visibly being played, which
    // is a state nobody at the table would recognise.
    if (card.suit === TRUMP) s.spadesBroken = true

    s.totalPlays++
    if (forced) s.forcedPlays++

    s.actingSeatIndex =
      trick.plays.length === SPADES_SEATS ? -1 : (seatIndex + 1) % SPADES_SEATS
  }

  get trickComplete(): boolean {
    return this.state.currentTrick?.plays.length === SPADES_SEATS
  }

  /**
   * Awards the trick to the highest spade, or to the highest card of the led
   * suit if nobody trumped.
   *
   * Deliberately does *not* open the next trick — same reason as at Hearts. The
   * four cards and the winner's name are the informative moment, and clearing
   * them in the same frame means the operator never sees who took anything.
   */
  resolveTrick(): SpadesTrick {
    const s = this.state
    const trick = s.currentTrick
    if (!trick || trick.plays.length !== SPADES_SEATS) throw new Error('the trick is not complete')

    const best = trickWinner(trick.plays, trick.leadSuit, TRUMP)
    trick.winnerSeatIndex = best.seatIndex
    const winner = s.players[best.seatIndex]
    trick.winnerName = winner.name
    winner.tricksWon++
    this.teamOf(best.seatIndex).tricksWon++

    s.lastTrick = trick
    s.currentTrick = null
    s.actingSeatIndex = -1
    if (s.trickNumber >= TRICKS_PER_HAND) s.phase = 'handComplete'
    return trick
  }

  /** True between a resolved trick and the next one being dealt out. */
  get awaitingNextTrick(): boolean {
    return this.state.phase === 'playing' && this.state.currentTrick === null
  }

  /** Opens the next trick, led by whoever took the last one. */
  startNextTrick(): void {
    const s = this.state
    if (!this.awaitingNextTrick) throw new Error('a trick is already in progress')
    const leader = s.lastTrick?.winnerSeatIndex
    if (leader === undefined) throw new Error('no previous trick to lead from')
    this.openTrick(leader)
  }

  get handComplete(): boolean {
    return this.state.phase === 'handComplete'
  }

  /**
   * Scores the hand and rolls the totals on.
   *
   * The whole of the scoring lives in `scoreTeam` below, which is a pure
   * function of the numbers — so the test can check it against an independently
   * written table without driving thirteen tricks to get there.
   */
  scoreHand(): SpadesHandScore[] {
    const s = this.state
    if (s.phase !== 'handComplete') throw new Error('the hand is not finished')

    const scored: SpadesHandScore[] = []
    for (const team of s.teams) {
      const nils = team.seatIndices
        .map((i) => s.players[i])
        .filter((p) => p.bid === 0)
        .map((p) => ({
          name: p.name,
          seatIndex: p.seatIndex,
          made: p.tricksWon === 0,
          blind: p.blindNil
        }))

      const result = scoreTeam({
        contract: team.contract,
        tricksWon: team.tricksWon,
        nilTricks: team.seatIndices
          .map((i) => s.players[i])
          .filter((p) => p.bid === 0)
          .reduce((sum, p) => sum + p.tricksWon, 0),
        bagsBefore: team.bags,
        nilsMade: nils.filter((n) => n.made).length,
        nilsFailed: nils.filter((n) => !n.made).length,
        // What each nil is worth on its own — 100, or 200 for a blind one.
        nilBonuses: nils.map((n) => (n.blind ? BLIND_NIL_VALUE : NIL_VALUE)),
        nilTricksCountToContract: this.rules.nilTricksCountToContract
      })

      team.score += result.delta
      team.bags = result.bagsAfter
      team.lastHandDelta = result.delta
      for (const nil of nils) {
        if (nil.made) s.players[nil.seatIndex].nilsMade++
      }
      scored.push({ team, nils, ...result })
    }

    for (const player of s.players) player.lastHandTricks = player.tricksWon
    s.handsPlayed++
    s.lastHandSummary = scored
      .map((r) => `${r.team.name} ${r.delta >= 0 ? '+' : ''}${r.delta} (${r.team.score})`)
      .join(' · ')

    if (this.isMatchOver && !this.isDeadHeat) {
      s.phase = 'complete'
      s.winnerName = this.winnerName
    }
    return scored
  }

  /** Every card still unplayed, for the card-conservation invariant. */
  get cardsInHands(): Card[] {
    return this.state.players.flatMap((p) => p.hand)
  }
}

export interface SpadesTeamScoreInput {
  contract: number
  /** Every trick the partnership took, the nil bidders' included. */
  tricksWon: number
  /** Of those, the ones taken by a seat that bid nil. */
  nilTricks: number
  bagsBefore: number
  nilsMade: number
  nilsFailed: number
  /**
   * What each nil at this partnership is worth on its own: 100 ordinarily, 200
   * for one declared blind. Length must equal `nilsMade + nilsFailed`.
   */
  nilBonuses: number[]
  /**
   * Whether `nilTricks` count towards the contract. See `SpadesRules`; false is
   * the house rule where a nil bidder's tricks become bags only.
   */
  nilTricksCountToContract: boolean
}

export interface SpadesTeamScore {
  /** Points from the contract itself: +10 a trick, or −10 a trick when set. */
  contractPoints: number
  /** Overtricks scored this hand, 1 point each. Zero when the contract failed. */
  bagsGained: number
  /** −100 for each ten bags the count rolled through. */
  bagPenalty: number
  nilPoints: number
  bagsAfter: number
  made: boolean
  /** Both partners bid nil, so the nil half was scored as a single unit. */
  doubleNil: boolean
  delta: number
}

export interface SpadesHandScore extends SpadesTeamScore {
  team: SpadesTeam
  nils: Array<{ name: string; seatIndex: number; made: boolean; blind: boolean }>
}

/**
 * The whole of Spades scoring, as arithmetic on five numbers.
 *
 * Pure and separate from the table on purpose: the scoring is where the
 * variants disagree most, so it is the part most worth checking against an
 * independently written oracle rather than against thirteen played tricks.
 */
export function scoreTeam(input: SpadesTeamScoreInput): SpadesTeamScore {
  const {
    contract,
    tricksWon,
    nilTricks,
    bagsBefore,
    nilsMade,
    nilsFailed,
    nilBonuses,
    nilTricksCountToContract
  } = input
  if (nilBonuses.length !== nilsMade + nilsFailed) {
    throw new Error('nilBonuses must carry one value per nil bid')
  }

  // Under the house rule a nil bidder's tricks are worth nothing to the
  // contract — the partner's bid has to be made unaided — but they are still
  // the partnership's tricks, so they still become bags.
  const contractTricks = nilTricksCountToContract ? tricksWon : tricksWon - nilTricks
  const made = contractTricks >= contract

  const contractPoints = made ? contract * 10 : contract * -10
  // A set partnership takes no bags at all — the overtricks it did take are
  // simply not counted. Only a made contract accumulates them.
  const bagsGained = made ? tricksWon - contract : 0

  const bagsTotal = bagsBefore + bagsGained
  const penalties = Math.floor(bagsTotal / BAGS_PER_PENALTY)
  const bagPenalty = -penalties * BAG_PENALTY
  const bagsAfter = bagsTotal - penalties * BAGS_PER_PENALTY

  // **Double nil is scored as one thing, not as two nils.** Both partners
  // bidding nil doubles the pair's nil bonuses if they both bring it home, and
  // carries no penalty at all if either fails — which is not the same as
  // +100/−100 each, and in particular a mixed result is 0 by rule rather than
  // by two halves cancelling. The failed case is not free even so: the
  // contract is 0, so every trick the pair took is a bag.
  // One rule covers all four rows of the published table rather than four
  // special cases. A lone nil is worth its own bonus either way; **both
  // partners on nil is scored as a unit** — "double the combined bonus" if they
  // both bring it home, and no penalty at all if either fails.
  //
  //   two ordinary   2 x (100 + 100) = 400
  //   two blind      2 x (200 + 200) = 800
  //   one of each    2 x (100 + 200) = 600
  //
  // The mixed pair is not in the table at all; falling out of the general rule
  // rather than needing a fifth row is the reason to write it this way.
  const nilCount = nilsMade + nilsFailed
  const combined = nilBonuses.reduce((sum, bonus) => sum + bonus, 0)
  const nilPoints =
    nilCount === SPADES_SEATS / 2
      ? nilsFailed === 0
        ? combined * 2
        : 0
      : nilsMade > 0
        ? combined
        : -combined

  return {
    contractPoints,
    bagsGained,
    bagPenalty,
    nilPoints,
    bagsAfter,
    made,
    doubleNil: nilCount === SPADES_SEATS / 2,
    delta: contractPoints + bagsGained + bagPenalty + nilPoints
  }
}

/**
 * A defensible bid from a hand alone, used when a model cannot produce one.
 *
 * **It never returns 0.** A fallback nil would be a −100 swing charged to a
 * seat that simply failed to answer, which is a far worse outcome than a
 * conservative 1 — so the count is clamped up. A model that wants nil has to
 * ask for it.
 */
export function suggestedBid(hand: Card[]): number {
  const spades = hand.filter((c) => c.suit === TRUMP)
  let tricks = 0

  // High spades win on their own; the rest of a long trump holding wins by
  // outlasting everyone else's.
  if (spades.some((c) => c.rank === 14)) tricks++
  if (spades.some((c) => c.rank === 13) && spades.length >= 2) tricks++
  if (spades.some((c) => c.rank === 12) && spades.length >= 3) tricks++
  tricks += Math.max(0, spades.length - 4)

  // Side-suit honours, discounted for being trumpable: an ace usually holds,
  // a king only when it has a card to hide behind.
  for (const suit of ['c', 'd', 'h'] as const) {
    const cards = hand.filter((c) => c.suit === suit)
    if (cards.some((c) => c.rank === 14)) tricks++
    if (cards.some((c) => c.rank === 13) && cards.length >= 2) tricks++
  }

  return Math.min(TRICKS_PER_HAND, Math.max(1, tricks))
}

function makeTeam(index: number, players: SpadesPlayer[]): SpadesTeam {
  const seatIndices = players.filter((p) => p.teamIndex === index).map((p) => p.seatIndex)
  return {
    index,
    // Seat 0 sits south and seat 1 west, so team 0 is North–South by
    // construction — the partnership is visible on the felt without a legend.
    name: index === 0 ? 'North–South' : 'East–West',
    seatIndices,
    score: 0,
    bags: 0,
    contract: 0,
    tricksWon: 0,
    lastHandDelta: 0
  }
}

export { sortHand }
