import { freshDeck, shuffle, cardCode, type Card } from '../../../shared/cards.ts'
import type {
  PokerAction,
  PokerRules,
  PokerSeat,
  PokerState,
  SidePot,
  Street
} from '../../../shared/types.ts'
import { evaluateBest, type HandRank } from './handEval.ts'

export interface LegalActions {
  canFold: boolean
  canCheck: boolean
  canCall: boolean
  /** Extra chips needed to call, already capped at the seat's stack. */
  callAmount: number
  /** True when the call would put the seat all-in. */
  callIsAllIn: boolean
  canRaise: boolean
  /** Smallest legal total to raise *to*. */
  minRaiseTo: number
  /** Largest legal total to raise *to* (the seat's whole stack). */
  maxRaiseTo: number
}

export interface PotAward {
  seatId: string
  seatName: string
  amount: number
  potIndex: number
  handLabel?: string
}

export type PokerStep =
  /** A model must act for this seat. */
  | { kind: 'await'; seatIndex: number }
  /** Community cards were just dealt. */
  | { kind: 'street'; street: Street; cards: Card[] }
  /** Everyone folded to one player, or hands were compared. */
  | { kind: 'payout'; awards: PotAward[]; showdown: boolean }
  /** The hand is fully settled; call startHand() for the next one. */
  | { kind: 'handComplete' }

export interface SeatSeed {
  id: string
  name: string
  modelId: string
}

export class PokerTable {
  readonly state: PokerState
  private deck: Card[] = []
  /** Seats that still owe an action on the current street. */
  private needsToAct = new Set<number>()
  /** The seat *before* the next one to act; searching starts from here. */
  private actionAnchor = 0
  private handOver = false
  private payoutDone = false
  private lastRanks = new Map<string, HandRank>()

  constructor(seeds: SeatSeed[], private readonly rules: PokerRules) {
    if (seeds.length < 2 || seeds.length > 8) {
      throw new Error(`poker needs 2-8 players, got ${seeds.length}`)
    }
    this.state = {
      phase: 'idle',
      handNumber: 0,
      street: 'preflop',
      board: [],
      seats: seeds.map((seed, i) => this.blankSeat(seed, i)),
      buttonIndex: 0,
      actingSeatIndex: -1,
      pot: 0,
      currentBet: 0,
      minRaiseIncrement: rules.bigBlind,
      smallBlind: rules.smallBlind,
      bigBlind: rules.bigBlind,
      sidePots: [],
      handsPlayed: 0
    }
  }

  private blankSeat(seed: SeatSeed, index: number): PokerSeat {
    return {
      id: seed.id,
      name: seed.name,
      modelId: seed.modelId,
      seatIndex: index,
      stack: this.rules.startingStack,
      cards: [],
      cardsRevealed: false,
      folded: false,
      allIn: false,
      committed: 0,
      totalCommitted: 0,
      busted: false,
      wonThisHand: 0
    }
  }

  /** Seats that still have chips and can be dealt in. */
  private get liveSeats(): PokerSeat[] {
    return this.state.seats.filter((s) => !s.busted)
  }

  get isMatchOver(): boolean {
    return this.liveSeats.length <= 1
  }

  get winnerName(): string | undefined {
    return this.liveSeats[0]?.name
  }

  /* ------------------------------------------------------------ hand setup */

  startHand(): void {
    const s = this.state
    if (this.isMatchOver) {
      s.phase = 'complete'
      return
    }

    s.handNumber++
    if (this.rules.blindIncreaseEvery > 0 && s.handNumber > 1) {
      if ((s.handNumber - 1) % this.rules.blindIncreaseEvery === 0) {
        s.smallBlind *= 2
        s.bigBlind *= 2
      }
    }

    this.deck = shuffle(freshDeck())
    this.handOver = false
    this.payoutDone = false
    this.lastRanks.clear()

    s.phase = 'hand'
    s.street = 'preflop'
    s.board = []
    s.pot = 0
    s.sidePots = []
    s.currentBet = 0
    s.minRaiseIncrement = s.bigBlind
    s.lastHandSummary = undefined

    for (const seat of s.seats) {
      seat.cards = []
      seat.cardsRevealed = false
      seat.folded = seat.busted
      seat.allIn = false
      seat.committed = 0
      seat.totalCommitted = 0
      seat.lastActionLabel = undefined
      seat.showdownHand = undefined
      seat.wonThisHand = 0
    }

    // Move the button to the next seat that still has chips.
    s.buttonIndex = this.nextSeatIndex(s.buttonIndex, (seat) => !seat.busted)

    const live = this.liveSeats
    const headsUp = live.length === 2
    const sbIndex = headsUp
      ? s.buttonIndex
      : this.nextSeatIndex(s.buttonIndex, (seat) => !seat.busted)
    const bbIndex = this.nextSeatIndex(sbIndex, (seat) => !seat.busted)

    this.postBlind(sbIndex, s.smallBlind)
    this.postBlind(bbIndex, s.bigBlind)

    // Two cards each, one at a time, starting left of the button.
    for (let round = 0; round < 2; round++) {
      let idx = this.nextSeatIndex(s.buttonIndex, (seat) => !seat.busted)
      for (let n = 0; n < live.length; n++) {
        s.seats[idx].cards.push(this.deck.pop() as Card)
        idx = this.nextSeatIndex(idx, (seat) => !seat.busted)
      }
    }

    this.needsToAct = new Set(
      s.seats.filter((seat) => this.canAct(seat)).map((seat) => seat.seatIndex)
    )
    // Preflop action opens to the left of the big blind.
    this.actionAnchor = bbIndex
    s.actingSeatIndex = -1
  }

  private postBlind(seatIndex: number, amount: number): void {
    const seat = this.state.seats[seatIndex]
    const posted = Math.min(amount, seat.stack)
    seat.stack -= posted
    seat.committed += posted
    seat.totalCommitted += posted
    this.state.pot += posted
    if (seat.stack === 0) seat.allIn = true
    this.state.currentBet = Math.max(this.state.currentBet, seat.committed)
    seat.lastActionLabel = amount === this.state.smallBlind ? 'SB' : 'BB'
  }

  private canAct(seat: PokerSeat): boolean {
    return !seat.busted && !seat.folded && !seat.allIn
  }

  private nextSeatIndex(from: number, predicate: (seat: PokerSeat) => boolean): number {
    const n = this.state.seats.length
    for (let step = 1; step <= n; step++) {
      const idx = (from + step) % n
      if (predicate(this.state.seats[idx])) return idx
    }
    return from
  }

  /* --------------------------------------------------------------- actions */

  get actingSeat(): PokerSeat | undefined {
    const idx = this.state.actingSeatIndex
    return idx >= 0 ? this.state.seats[idx] : undefined
  }

  legalActions(): LegalActions {
    const seat = this.actingSeat
    const s = this.state
    if (!seat) {
      return {
        canFold: false, canCheck: false, canCall: false, callAmount: 0,
        callIsAllIn: false, canRaise: false, minRaiseTo: 0, maxRaiseTo: 0
      }
    }
    const toCall = Math.min(s.currentBet - seat.committed, seat.stack)
    const canCheck = s.currentBet - seat.committed <= 0
    const maxRaiseTo = seat.committed + seat.stack
    // A raise must beat the current bet; if the stack cannot reach the normal
    // minimum, an all-in shove is still allowed.
    const minRaiseTo = Math.min(s.currentBet + s.minRaiseIncrement, maxRaiseTo)

    return {
      canFold: true,
      canCheck,
      canCall: !canCheck && toCall > 0,
      callAmount: toCall,
      callIsAllIn: !canCheck && toCall >= seat.stack,
      canRaise: maxRaiseTo > s.currentBet,
      minRaiseTo,
      maxRaiseTo
    }
  }

  /** Applies an action for the acting seat and returns a log label. */
  applyAction(action: PokerAction): string {
    const seat = this.actingSeat
    if (!seat) throw new Error('no seat is acting')
    const s = this.state
    const legal = this.legalActions()
    let label: string

    switch (action.kind) {
      case 'fold': {
        seat.folded = true
        label = 'folds'
        break
      }
      case 'check': {
        if (!legal.canCheck) throw new Error('cannot check facing a bet')
        label = 'checks'
        break
      }
      case 'call': {
        if (legal.canCheck) {
          label = 'checks'
          break
        }
        this.commit(seat, legal.callAmount)
        label = seat.allIn ? `calls ${legal.callAmount} (all-in)` : `calls ${legal.callAmount}`
        break
      }
      case 'raise': {
        if (!legal.canRaise) throw new Error('cannot raise')
        const rawTo = Math.round(action.amount ?? 0)
        const raiseTo = Math.max(legal.minRaiseTo, Math.min(rawTo, legal.maxRaiseTo))
        const increment = raiseTo - s.currentBet
        const wasOpen = s.currentBet === 0

        this.commit(seat, raiseTo - seat.committed)

        // An undersized all-in does not reopen betting for players who already acted.
        if (increment >= s.minRaiseIncrement) {
          s.minRaiseIncrement = increment
          for (const other of s.seats) {
            if (other.seatIndex !== seat.seatIndex && this.canAct(other)) {
              this.needsToAct.add(other.seatIndex)
            }
          }
        }
        s.currentBet = Math.max(s.currentBet, seat.committed)

        const verb = wasOpen ? 'bets' : 'raises to'
        label = seat.allIn ? `${verb} ${raiseTo} (all-in)` : `${verb} ${raiseTo}`
        break
      }
      default:
        throw new Error(`unknown poker action: ${(action as PokerAction).kind}`)
    }

    seat.lastActionLabel = label
    this.needsToAct.delete(seat.seatIndex)
    this.actionAnchor = seat.seatIndex
    s.actingSeatIndex = -1
    return label
  }

  private commit(seat: PokerSeat, amount: number): void {
    const chips = Math.max(0, Math.min(amount, seat.stack))
    seat.stack -= chips
    seat.committed += chips
    seat.totalCommitted += chips
    this.state.pot += chips
    if (seat.stack === 0) seat.allIn = true
  }

  /* ----------------------------------------------------------- progression */

  /**
   * Drives the hand forward. Returns what the caller must do next: either ask a
   * model to act, or simply render what just happened and call step() again.
   */
  step(): PokerStep {
    const s = this.state

    if (this.handOver) {
      if (!this.payoutDone) return this.doPayout()
      s.actingSeatIndex = -1
      s.phase = this.isMatchOver ? 'complete' : 'hand'
      return { kind: 'handComplete' }
    }

    const contenders = s.seats.filter((seat) => !seat.folded && !seat.busted)
    if (contenders.length <= 1) {
      this.handOver = true
      return this.doPayout()
    }

    // Someone still owes an action on this street.
    const pending = [...this.needsToAct].filter((i) => this.canAct(s.seats[i]))
    if (pending.length > 0) {
      const next = this.nextSeatIndex(
        this.actionAnchor,
        (seat) => this.needsToAct.has(seat.seatIndex) && this.canAct(seat)
      )
      s.actingSeatIndex = next
      return { kind: 'await', seatIndex: next }
    }

    // Betting round complete: move to the next street.
    return this.advanceStreet()
  }

  private advanceStreet(): PokerStep {
    const s = this.state
    for (const seat of s.seats) seat.committed = 0
    s.currentBet = 0
    s.minRaiseIncrement = s.bigBlind
    s.actingSeatIndex = -1

    const nextStreet: Record<string, Street> = {
      preflop: 'flop',
      flop: 'turn',
      turn: 'river',
      river: 'showdown'
    }
    s.street = nextStreet[s.street]

    if (s.street === 'showdown') {
      this.handOver = true
      return this.doPayout()
    }

    this.deck.pop() // burn
    const count = s.street === 'flop' ? 3 : 1
    const dealt: Card[] = []
    for (let i = 0; i < count; i++) dealt.push(this.deck.pop() as Card)
    s.board.push(...dealt)

    const actors = s.seats.filter((seat) => this.canAct(seat))
    // With at most one player able to act, the rest of the board runs out with
    // no further betting.
    this.needsToAct = actors.length >= 2 ? new Set(actors.map((seat) => seat.seatIndex)) : new Set()
    // Postflop action opens to the left of the button.
    this.actionAnchor = s.buttonIndex

    return { kind: 'street', street: s.street, cards: dealt }
  }

  /* ------------------------------------------------------------- showdown */

  private buildPots(): SidePot[] {
    const s = this.state
    const levels = [...new Set(s.seats.map((seat) => seat.totalCommitted))]
      .filter((v) => v > 0)
      .sort((a, b) => a - b)

    const pots: SidePot[] = []
    let previous = 0
    for (const level of levels) {
      let amount = 0
      for (const seat of s.seats) {
        amount += Math.min(seat.totalCommitted, level) - Math.min(seat.totalCommitted, previous)
      }
      const eligible = s.seats
        .filter((seat) => !seat.folded && seat.totalCommitted >= level)
        .map((seat) => seat.id)
      if (amount > 0 && eligible.length > 0) pots.push({ amount, eligibleSeatIds: eligible })
      previous = level
    }

    // Fold neighbouring pots together when the same players are eligible.
    const merged: SidePot[] = []
    for (const pot of pots) {
      const last = merged[merged.length - 1]
      if (last && sameMembers(last.eligibleSeatIds, pot.eligibleSeatIds)) {
        last.amount += pot.amount
      } else {
        merged.push({ ...pot })
      }
    }
    return merged
  }

  private doPayout(): PokerStep {
    const s = this.state
    this.payoutDone = true
    this.handOver = true
    s.actingSeatIndex = -1

    const contenders = s.seats.filter((seat) => !seat.folded && !seat.busted)
    const showdown = contenders.length > 1
    const pots = this.buildPots()
    s.sidePots = pots
    const awards: PotAward[] = []

    if (showdown) {
      s.street = 'showdown'
      s.phase = 'showdown'
      for (const seat of contenders) {
        const rank = evaluateBest([...seat.cards, ...s.board])
        this.lastRanks.set(seat.id, rank)
        seat.showdownHand = rank.label
        seat.cardsRevealed = true
      }
    }

    pots.forEach((pot, potIndex) => {
      const eligible = pot.eligibleSeatIds
        .map((id) => s.seats.find((seat) => seat.id === id) as PokerSeat)
        .filter((seat) => seat && !seat.folded)

      if (eligible.length === 0) return

      let winners: PokerSeat[]
      if (!showdown || eligible.length === 1) {
        winners = [eligible[0]]
      } else {
        let bestValue = -1
        winners = []
        for (const seat of eligible) {
          const rank = this.lastRanks.get(seat.id)
          if (!rank) continue
          if (rank.value > bestValue) {
            bestValue = rank.value
            winners = [seat]
          } else if (rank.value === bestValue) {
            winners.push(seat)
          }
        }
      }

      const share = Math.floor(pot.amount / winners.length)
      let remainder = pot.amount - share * winners.length

      // Odd chips go to the first winner clockwise from the button.
      const ordered = winners.slice().sort((a, b) => this.seatOrderFromButton(a) - this.seatOrderFromButton(b))
      for (const seat of ordered) {
        let amount = share
        if (remainder > 0) {
          amount++
          remainder--
        }
        seat.stack += amount
        seat.wonThisHand += amount
        awards.push({
          seatId: seat.id,
          seatName: seat.name,
          amount,
          potIndex,
          handLabel: showdown ? this.lastRanks.get(seat.id)?.label : undefined
        })
      }
    })

    for (const seat of s.seats) {
      if (!seat.busted && seat.stack <= 0) seat.busted = true
    }
    s.pot = 0
    s.handsPlayed++

    const winnerText = awards.length
      ? summariseAwards(awards)
      : 'No chips were awarded'
    s.lastHandSummary = showdown ? `Showdown — ${winnerText}` : winnerText

    return { kind: 'payout', awards, showdown }
  }

  private seatOrderFromButton(seat: PokerSeat): number {
    const n = this.state.seats.length
    return (seat.seatIndex - this.state.buttonIndex + n) % n
  }

  /* -------------------------------------------------- roster changes */

  /**
   * Seats a new player between hands. They buy in for `stack` chips, which are
   * new money entering the table rather than taken from anyone.
   */
  addSeat(seed: SeatSeed, stack: number): void {
    const s = this.state
    if (s.seats.length >= 8) throw new Error('The table is full at 8 seats.')
    if (s.seats.some((seat) => seat.id === seed.id)) return

    const seat = this.blankSeat(seed, s.seats.length)
    seat.stack = Math.max(1, Math.round(stack))
    // Not dealt in until the next hand starts.
    seat.folded = true
    s.seats.push(seat)
  }

  /**
   * Removes a player between hands; their chips leave the table with them.
   * Returns true if a seat was actually removed.
   */
  removeSeat(id: string): boolean {
    const s = this.state
    const index = s.seats.findIndex((seat) => seat.id === id)
    if (index === -1) return false

    s.seats.splice(index, 1)
    // Seat indices are positional, so renumber and keep the button in range.
    s.seats.forEach((seat, i) => {
      seat.seatIndex = i
    })
    if (s.seats.length === 0) {
      s.buttonIndex = 0
    } else if (s.buttonIndex >= s.seats.length) {
      s.buttonIndex = s.seats.length - 1
    } else if (index <= s.buttonIndex && s.buttonIndex > 0) {
      // Keep the button on the same player when someone ahead of it leaves.
      s.buttonIndex--
    }
    s.actingSeatIndex = -1
    return true
  }

  /** Text description of a seat's hole cards, for prompts. */
  holeCards(seatIndex: number): string {
    return this.state.seats[seatIndex].cards.map(cardCode).join(' ')
  }
}

function sameMembers(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

function summariseAwards(awards: PotAward[]): string {
  const byPlayer = new Map<string, { amount: number; label?: string }>()
  for (const award of awards) {
    const entry = byPlayer.get(award.seatName) ?? { amount: 0, label: award.handLabel }
    entry.amount += award.amount
    entry.label = entry.label ?? award.handLabel
    byPlayer.set(award.seatName, entry)
  }
  return [...byPlayer.entries()]
    .map(([name, e]) => `${name} wins ${e.amount}${e.label ? ` with ${e.label.toLowerCase()}` : ''}`)
    .join('; ')
}
