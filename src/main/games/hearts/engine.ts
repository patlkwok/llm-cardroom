import { cardCode, freshDeck, shuffle, type Card, type Suit } from '../../../shared/cards.ts'
import { GAMES } from '../../../shared/types.ts'
import type {
  HeartsPlayer,
  HeartsRules,
  HeartsState,
  HeartsTrick,
  PassDirection
} from '../../../shared/types.ts'

export const HEARTS_SEATS = GAMES.hearts.minPlayers
export const CARDS_PER_HAND = 52 / HEARTS_SEATS
/** The queen of spades, worth 13 on her own. */
export const QUEEN_OF_SPADES: Card = { rank: 12, suit: 's' }
/** The two of clubs, which always leads the first trick. */
export const TWO_OF_CLUBS: Card = { rank: 2, suit: 'c' }

export interface HeartsSeed {
  id: string
  name: string
  modelId: string
}

/** Left, right, across, hold — and round again. */
const PASS_CYCLE: PassDirection[] = ['left', 'right', 'across', 'hold']

/** How many seats to the left this hand's cards travel. Hold passes nowhere. */
const PASS_OFFSET: Record<PassDirection, number> = { left: 1, right: 3, across: 2, hold: 0 }

export function cardPoints(card: Card): number {
  if (card.suit === 'h') return 1
  if (sameCard(card, QUEEN_OF_SPADES)) return 13
  return 0
}

export function sameCard(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit
}

/** All 26 penalty points in a deck: thirteen hearts plus the queen. */
export const POINTS_PER_HAND = 26

/**
 * Hearts, in the variant everyone means by the name — strictly Black Lady, but
 * nobody calls it that.
 *
 * The rules below are decisions, not lookups: variants genuinely disagree on
 * every one of them, so they are settled here and stated in force in the system
 * prompt. In particular the **queen of spades does not break hearts**; only a
 * heart actually being played does.
 *
 * Exactly four seats, fixed for the match. There is no addSeat/removeSeat here
 * at all, which is what makes dealer rotation plain modulo 4 and rules out the
 * whole class of seat-renumbering bugs the other two games have had.
 */
export class HeartsTable {
  readonly state: HeartsState
  /** Seat ids still owed a passing decision this hand, in seat order. */
  private passQueue: string[] = []
  /** What each seat chose to pass, held until every seat has chosen. */
  private readonly chosenPass = new Map<string, Card[]>()

  constructor(seeds: HeartsSeed[], private readonly rules: HeartsRules) {
    if (seeds.length !== HEARTS_SEATS) {
      throw new Error(`hearts needs exactly ${HEARTS_SEATS} players, got ${seeds.length}`)
    }
    this.state = {
      kind: 'hearts',
      phase: 'idle',
      handNumber: 0,
      handsPlayed: 0,
      passDirection: PASS_CYCLE[0],
      players: seeds.map((seed, index) => ({
        id: seed.id,
        name: seed.name,
        modelId: seed.modelId,
        seatIndex: index,
        hand: [],
        totalScore: 0,
        handScore: 0,
        lastHandScore: 0,
        tricksWon: 0,
        moonShots: 0,
        passedCards: [],
        receivedCards: []
      })),
      currentTrick: null,
      lastTrick: null,
      trickNumber: 0,
      leadSeatIndex: 0,
      actingSeatIndex: -1,
      heartsBroken: false,
      queenPlayed: false,
      forcedPlays: 0,
      totalPlays: 0
    }
  }

  player(id: string): HeartsPlayer | undefined {
    return this.state.players.find((p) => p.id === id)
  }

  /** Seats ordered by score, best (lowest) first. */
  get standings(): HeartsPlayer[] {
    return [...this.state.players].sort((a, b) => a.totalScore - b.totalScore)
  }

  /** The match ends the moment anyone reaches the target. */
  get isMatchOver(): boolean {
    return this.state.players.some((p) => p.totalScore >= this.rules.targetScore)
  }

  /** Lowest total takes it; an exact tie names everyone level at the top. */
  get winnerName(): string {
    const best = Math.min(...this.state.players.map((p) => p.totalScore))
    const winners = this.state.players.filter((p) => p.totalScore === best)
    return winners.map((p) => p.name).join(' and ')
  }

  /* ------------------------------------------------------------ the deal */

  startHand(): void {
    const s = this.state
    s.handNumber++
    s.trickNumber = 0
    s.currentTrick = null
    s.lastTrick = null
    s.heartsBroken = false
    s.queenPlayed = false
    s.actingSeatIndex = -1
    s.lastHandSummary = undefined
    // Left, right, across, hold, repeating from the first hand.
    s.passDirection = PASS_CYCLE[(s.handNumber - 1) % PASS_CYCLE.length]

    const deck = shuffle(freshDeck())
    s.players.forEach((player, index) => {
      player.hand = sortHand(deck.slice(index * CARDS_PER_HAND, (index + 1) * CARDS_PER_HAND))
      player.handScore = 0
      player.passedCards = []
      player.receivedCards = []
    })

    this.chosenPass.clear()
    if (s.passDirection === 'hold') {
      this.passQueue = []
      s.phase = 'playing'
      this.openTrick(this.seatHoldingTwoOfClubs())
    } else {
      this.passQueue = s.players.map((p) => p.id)
      s.phase = 'passing'
    }
  }

  /* ----------------------------------------------------------- the pass */

  get passing(): boolean {
    return this.state.phase === 'passing'
  }

  /** The next seat owed a passing decision, or undefined once all have chosen. */
  get pendingPassSeat(): HeartsPlayer | undefined {
    const id = this.passQueue[0]
    return id === undefined ? undefined : this.player(id)
  }

  /** Which seat a given seat's three cards travel to this hand. */
  passRecipient(seatIndex: number): number {
    return (seatIndex + PASS_OFFSET[this.state.passDirection]) % HEARTS_SEATS
  }

  /**
   * Records one seat's three cards. Nothing moves until every seat has chosen —
   * passing simultaneously is the whole point, and moving cards seat by seat
   * would let a later seat pass a card it had only just been given.
   */
  setPass(seatId: string, cards: Card[]): void {
    if (this.state.phase !== 'passing') throw new Error('no pass is in progress')
    const index = this.passQueue.indexOf(seatId)
    if (index === -1) throw new Error(`${seatId} is not owed a pass`)
    const player = this.player(seatId)
    if (!player) throw new Error(`no such seat: ${seatId}`)

    if (cards.length !== 3) throw new Error(`a pass is exactly 3 cards, got ${cards.length}`)
    const remaining = [...player.hand]
    for (const card of cards) {
      const at = remaining.findIndex((held) => sameCard(held, card))
      if (at === -1) throw new Error(`${player.name} does not hold ${cardCode(card)}`)
      remaining.splice(at, 1)
    }

    this.passQueue.splice(index, 1)
    this.chosenPass.set(seatId, cards)
  }

  /**
   * Makes the exchange and starts the play. Any seat that never answered passes
   * its three highest cards, so an interrupted match still leaves 13 cards in
   * every hand rather than a half-finished exchange.
   */
  completePass(): void {
    const s = this.state
    if (s.phase !== 'passing') throw new Error('no pass is in progress')

    for (const id of [...this.passQueue]) {
      const player = this.player(id)
      if (player) this.setPass(id, sortHand(player.hand).slice(-3))
    }

    // Take every card out first, then deal them on: doing it seat by seat would
    // let a seat receive a card and pass it on in the same exchange.
    const outgoing = new Map<number, Card[]>()
    for (const player of s.players) {
      const cards = this.chosenPass.get(player.id) ?? []
      player.hand = player.hand.filter((held) => !cards.some((c) => sameCard(c, held)))
      player.passedCards = cards
      outgoing.set(player.seatIndex, cards)
    }
    for (const player of s.players) {
      const cards = outgoing.get(player.seatIndex) ?? []
      const recipient = s.players[this.passRecipient(player.seatIndex)]
      recipient.hand = sortHand([...recipient.hand, ...cards])
      recipient.receivedCards = cards
    }

    this.chosenPass.clear()
    s.phase = 'playing'
    this.openTrick(this.seatHoldingTwoOfClubs())
  }

  /* ---------------------------------------------------------- the tricks */

  private seatHoldingTwoOfClubs(): number {
    const seat = this.state.players.find((p) => p.hand.some((c) => sameCard(c, TWO_OF_CLUBS)))
    if (!seat) throw new Error('nobody holds the two of clubs')
    return seat.seatIndex
  }

  private openTrick(leadSeatIndex: number): void {
    const s = this.state
    s.trickNumber++
    s.leadSeatIndex = leadSeatIndex
    s.actingSeatIndex = leadSeatIndex
    s.currentTrick = {
      number: s.trickNumber,
      // Set for real by the opening lead; nothing reads it before then.
      leadSuit: 'c',
      plays: [],
      points: 0
    }
  }

  get awaitingPlay(): boolean {
    return this.state.phase === 'playing' && this.state.actingSeatIndex >= 0
  }

  get actingPlayer(): HeartsPlayer | undefined {
    const index = this.state.actingSeatIndex
    return index >= 0 ? this.state.players[index] : undefined
  }

  /**
   * Every card the acting seat may legally play.
   *
   * This is the load-bearing method: when it returns one card the runner plays
   * it without asking a model at all, which removes both a paid call and a
   * failure surface from a move that was never in doubt.
   */
  legalPlays(seatIndex: number): Card[] {
    const s = this.state
    const player = s.players[seatIndex]
    if (!player || s.phase !== 'playing') return []
    const trick = s.currentTrick
    if (!trick) return []

    const leading = trick.plays.length === 0
    const firstTrick = s.trickNumber === 1

    if (leading) {
      // The two of clubs opens the hand, and nothing else may.
      if (firstTrick) return player.hand.filter((c) => sameCard(c, TWO_OF_CLUBS))

      // Hearts may not be led until one has actually been played. A seat left
      // holding nothing else may lead them anyway.
      if (!s.heartsBroken) {
        const nonHearts = player.hand.filter((c) => c.suit !== 'h')
        if (nonHearts.length > 0) return nonHearts
      }
      return [...player.hand]
    }

    // Following: the led suit if it is held at all. No first-trick filter is
    // needed here — trick one is always led with the two of clubs, and no club
    // carries points, so following suit cannot put any in.
    const followers = player.hand.filter((c) => c.suit === trick.leadSuit)
    if (followers.length > 0) return followers

    // Void in the led suit, so anything goes — except that no points fall on
    // the first trick. A seat holding nothing but points must still play one.
    if (firstTrick) {
      const safe = player.hand.filter((c) => cardPoints(c) === 0)
      if (safe.length > 0) return safe
    }
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

    player.hand = player.hand.filter((held) => !sameCard(held, card))
    if (trick.plays.length === 0) trick.leadSuit = card.suit
    trick.plays.push({ seatIndex, seatId: player.id, card })
    trick.points += cardPoints(card)

    // A heart actually being played is the only thing that breaks hearts. The
    // queen of spades does not, however often people insist otherwise.
    if (card.suit === 'h') s.heartsBroken = true
    if (sameCard(card, QUEEN_OF_SPADES)) s.queenPlayed = true

    s.totalPlays++
    if (forced) s.forcedPlays++

    s.actingSeatIndex =
      trick.plays.length === HEARTS_SEATS ? -1 : (seatIndex + 1) % HEARTS_SEATS
  }

  get trickComplete(): boolean {
    return this.state.currentTrick?.plays.length === HEARTS_SEATS
  }

  /**
   * Awards the trick to the highest card of the led suit, and stops there.
   *
   * Deliberately does *not* open the next trick. The four cards and the name of
   * whoever took them are the most informative moment in a hand, and opening
   * the next trick in the same call cleared them from the felt in the same
   * frame — the operator never saw who won anything. `startNextTrick` is a
   * separate step so the runner can hold the result on screen for a beat.
   */
  resolveTrick(): HeartsTrick {
    const s = this.state
    const trick = s.currentTrick
    if (!trick || trick.plays.length !== HEARTS_SEATS) throw new Error('the trick is not complete')

    let best = trick.plays[0]
    for (const play of trick.plays) {
      if (play.card.suit === trick.leadSuit && play.card.rank > best.card.rank) best = play
    }
    trick.winnerSeatIndex = best.seatIndex
    const winner = s.players[best.seatIndex]
    trick.winnerName = winner.name
    winner.tricksWon++
    winner.handScore += trick.points

    s.lastTrick = trick
    s.currentTrick = null
    s.actingSeatIndex = -1
    if (s.trickNumber >= CARDS_PER_HAND) s.phase = 'handComplete'
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
   * Shooting the moon — all 26 to one seat — scores 26 to *everybody else*
   * rather than -26 to the shooter, which is the Windows behaviour and what
   * players expect.
   */
  scoreHand(): { moonShooter?: HeartsPlayer; awarded: Array<{ player: HeartsPlayer; points: number }> } {
    const s = this.state
    if (s.phase !== 'handComplete') throw new Error('the hand is not finished')

    const shooter = s.players.find((p) => p.handScore === POINTS_PER_HAND)
    const awarded: Array<{ player: HeartsPlayer; points: number }> = []

    for (const player of s.players) {
      const points = shooter
        ? player === shooter
          ? 0
          : POINTS_PER_HAND
        : player.handScore
      player.lastHandScore = points
      player.totalScore += points
      awarded.push({ player, points })
    }
    if (shooter) shooter.moonShots++

    s.handsPlayed++
    s.lastHandSummary = shooter
      ? `${shooter.name} shot the moon — 26 to everybody else.`
      : awarded
          .filter((a) => a.points > 0)
          .map((a) => `${a.player.name} +${a.points}`)
          .join(', ') || 'No points taken.'

    if (this.isMatchOver) {
      s.phase = 'complete'
      s.winnerName = this.winnerName
    }
    return { moonShooter: shooter, awarded }
  }

  /** Every card still unplayed, for the card-conservation invariant. */
  get cardsInHands(): Card[] {
    return this.state.players.flatMap((p) => p.hand)
  }
}

/** By suit then rank, so a rendered hand and a prompt read the same way. */
export function sortHand(cards: Card[]): Card[] {
  const order: Record<Suit, number> = { c: 0, d: 1, s: 2, h: 3 }
  return [...cards].sort((a, b) => order[a.suit] - order[b.suit] || a.rank - b.rank)
}
