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
 * - **A team's tricks all count together**, the nil bidder's included. So a
 *   trick a nil bidder is forced to take breaks the nil *and* counts towards
 *   the partner's contract. This is the widely played version and it is the one
 *   that keeps `team0.tricksWon + team1.tricksWon === 13` true, which is the
 *   conservation invariant this engine is tested against.
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
      player.tricksWon = 0
    })
    for (const team of s.teams) {
      team.contract = 0
      team.tricksWon = 0
      team.lastHandDelta = 0
    }

    // Bidding opens to the dealer's left and runs round the table, so every
    // seat but the first bids knowing something about its partner.
    s.phase = 'bidding'
    s.biddingSeatIndex = this.leftOfDealer()
    s.leadSeatIndex = this.leftOfDealer()
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

    const next = (seatIndex + 1) % SPADES_SEATS
    if (s.players[next].bid === null) {
      s.biddingSeatIndex = next
      return
    }

    // Everyone has bid. A nil adds nothing to the contract — it is scored on
    // its own, and its partner's bid has to stand up unaided.
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
        .map((p) => ({ name: p.name, seatIndex: p.seatIndex, made: p.tricksWon === 0 }))

      const result = scoreTeam({
        contract: team.contract,
        tricksWon: team.tricksWon,
        bagsBefore: team.bags,
        nilsMade: nils.filter((n) => n.made).length,
        nilsFailed: nils.filter((n) => !n.made).length
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
  tricksWon: number
  bagsBefore: number
  nilsMade: number
  nilsFailed: number
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
  delta: number
}

export interface SpadesHandScore extends SpadesTeamScore {
  team: SpadesTeam
  nils: Array<{ name: string; seatIndex: number; made: boolean }>
}

/**
 * The whole of Spades scoring, as arithmetic on five numbers.
 *
 * Pure and separate from the table on purpose: the scoring is where the
 * variants disagree most, so it is the part most worth checking against an
 * independently written oracle rather than against thirteen played tricks.
 */
export function scoreTeam(input: SpadesTeamScoreInput): SpadesTeamScore {
  const { contract, tricksWon, bagsBefore, nilsMade, nilsFailed } = input
  const made = tricksWon >= contract

  const contractPoints = made ? contract * 10 : contract * -10
  // A set partnership takes no bags at all — the overtricks it did take are
  // simply not counted. Only a made contract accumulates them.
  const bagsGained = made ? tricksWon - contract : 0

  const bagsTotal = bagsBefore + bagsGained
  const penalties = Math.floor(bagsTotal / BAGS_PER_PENALTY)
  const bagPenalty = -penalties * BAG_PENALTY
  const bagsAfter = bagsTotal - penalties * BAGS_PER_PENALTY

  const nilPoints = (nilsMade - nilsFailed) * NIL_VALUE

  return {
    contractPoints,
    bagsGained,
    bagPenalty,
    nilPoints,
    bagsAfter,
    made,
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
