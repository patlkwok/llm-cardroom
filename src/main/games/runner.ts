import { cardCode } from '../../shared/cards.ts'
import { GAMES } from '../../shared/types.ts'
import type {
  BlackjackAction,
  BlackjackPlayer,
  DecisionRecord,
  LogEntry,
  LogLevel,
  MatchEvent,
  MatchSettings,
  MatchSnapshot,
  MatchStatus,
  PlayerConfig,
  PlayerStats,
  PokerAction
} from '../../shared/types.ts'
import { BlackjackTable, describeValue } from './blackjack.ts'
import { PokerTable, type PokerStep } from './poker/engine.ts'
import { uncapitalise } from './poker/handEval.ts'
import { requestDecision } from './agent.ts'
import {
  buildBlackjackBetPrompt,
  buildBlackjackInsurancePrompt,
  buildBlackjackPrompt,
  buildPokerPrompt,
  parseBlackjackBetReply,
  parseBlackjackInsuranceReply,
  parseBlackjackReply,
  parsePokerReply
} from './prompts.ts'

export type Emit = (event: MatchEvent) => void

interface StatsAccumulator extends PlayerStats {
  latencyTotal: number
}

/**
 * The bit of a game table the roster code needs. Both games seat and unseat
 * models at a round boundary on identical terms, so they share one
 * implementation rather than two that can drift apart.
 */
interface RosterTable {
  /** Read fresh on every call: seating changes as the reconciliation runs. */
  seats: () => Array<{ id: string; name: string; chips: number }>
  capacity: number
  buyIn: number
  add: (player: PlayerConfig, buyIn: number) => void
  remove: (id: string) => boolean
}

export class MatchRunner {
  private status: MatchStatus = 'idle'
  private readonly abort = new AbortController()
  private pausePromise: Promise<void> | null = null
  private resumeSignal: (() => void) | null = null
  private logSeq = 0
  private decisionSeq = 0
  private errorText?: string

  private blackjack?: BlackjackTable
  private poker?: PokerTable
  private readonly stats = new Map<string, StatsAccumulator>()

  /**
   * Settings the operator may change while a match is running. Everything else
   * is fixed when the match starts, because changing it mid-game would
   * invalidate the table state.
   */
  private live: {
    stepDelayMs: number
    showEquity: boolean
    maxRounds: number
    blackjackBaseBet: number
    modelChoosesBet: boolean
  }

  /** The players currently at the table; poker seats can change between hands. */
  private roster: PlayerConfig[]
  /** A roster change waiting to be applied at the next hand boundary. */
  private pendingRoster: PlayerConfig[] | null = null

  constructor(
    private readonly settings: MatchSettings,
    private readonly apiKey: string,
    private readonly emit: Emit
  ) {
    this.live = {
      stepDelayMs: settings.stepDelayMs,
      showEquity: settings.showEquity,
      maxRounds: settings.maxRounds,
      blackjackBaseBet: settings.blackjack.baseBet,
      modelChoosesBet: settings.blackjack.modelChoosesBet
    }
    this.roster = [...settings.players]
    for (const player of settings.players) this.ensureStats(player.id)
  }

  private ensureStats(playerId: string): void {
    if (this.stats.has(playerId)) return
    this.stats.set(playerId, {
      playerId,
      decisions: 0,
      fallbacks: 0,
      errors: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      avgLatencyMs: 0,
      latencyTotal: 0
    })
  }

  /* ------------------------------------------------------------- controls */

  /**
   * Applies operator changes to a running match. A new stake takes effect on
   * the next deal; a hand already in progress settles at what it was dealt for.
   */
  applyLiveSettings(next: MatchSettings): void {
    const previousBet = this.live.blackjackBaseBet
    this.live = {
      stepDelayMs: Math.max(0, next.stepDelayMs),
      showEquity: next.showEquity,
      maxRounds: Math.max(0, Math.round(next.maxRounds)),
      blackjackBaseBet: Math.max(1, Math.round(next.blackjack.baseBet)),
      modelChoosesBet: next.blackjack.modelChoosesBet
    }
    if (this.blackjack && this.live.blackjackBaseBet !== previousBet) {
      this.log(
        'system',
        `Stake changed from ${previousBet} to ${this.live.blackjackBaseBet}, starting next round.`
      )
    }

    // Seats may be added or removed in either game, but only at a round
    // boundary — never with cards dealt or chips already in a pot.
    const seated = this.blackjack
      ? new Set(this.blackjack.state.players.map((player) => player.id))
      : this.poker
        ? new Set(this.poker.state.seats.map((seat) => seat.id))
        : null
    if (seated) this.queueRosterChange(next.players, seated)
  }

  /** Holds a roster change until the next round boundary. */
  private queueRosterChange(desired: PlayerConfig[], seated: Set<string>): void {
    const differs =
      desired.length !== this.roster.length ||
      desired.some((p, i) => {
        const current = this.roster[i]
        if (!current || p.id !== current.id) return true
        // A seated model is fixed for the match. An unseated one is still
        // fully editable — name, model and effort alike — so a change to any
        // of them has to re-queue the roster, or the edit is silently lost.
        // Comparing only the effort worked by accident while the roster and
        // the desired list were different lengths, and failed outright when
        // they were not: a join refused because the table was full leaves an
        // unseated model sitting in the roster at matching length.
        if (seated.has(p.id)) return false
        return (
          p.name !== current.name ||
          p.modelId !== current.modelId ||
          p.reasoningEffort !== current.reasoningEffort
        )
      })
    if (!differs) return

    // Read before the queue is replaced: a model already waiting to join is not
    // a new arrival, it is the same one being edited.
    const alreadyQueued = new Set(this.pendingRoster?.map((p) => p.id) ?? [])
    this.pendingRoster = [...desired]

    // Give the operator a chance to set the newcomer up before it is dealt in,
    // rather than racing the next round at whatever pace is set. Only on
    // arrival, though — pausing again on every later edit would stop the table
    // dead on each keystroke of a rename.
    const newcomers = desired.filter(
      (p) =>
        !seated.has(p.id) &&
        !alreadyQueued.has(p.id) &&
        !this.roster.some((existing) => existing.id === p.id)
    )
    if (newcomers.length > 0 && this.status === 'running') {
      this.pause()
      this.log(
        'system',
        `${newcomers.map((p) => p.name).join(', ')} will join next ` +
          `${GAMES[this.settings.game].roundNoun}. Set them up now, then resume.`
      )
    }
  }

  /**
   * Applies a queued roster change. Only ever called between rounds, so no seat
   * is added or removed with chips committed to a live pot or a live hand.
   */
  private reconcileRoster(table: RosterTable): void {
    const desired = this.pendingRoster
    if (!desired) return
    this.pendingRoster = null

    for (const seat of table.seats()) {
      if (desired.some((p) => p.id === seat.id)) continue
      const chips = seat.chips
      if (table.remove(seat.id)) {
        this.log('system', `${seat.name} leaves the table, taking ${chips} chips.`)
      }
    }

    for (const player of desired) {
      if (table.seats().some((seat) => seat.id === player.id)) continue
      if (table.seats().length >= table.capacity) {
        this.log('error', `${player.name} cannot join: the table is full at ${table.capacity} seats.`)
        continue
      }
      table.add(player, table.buyIn)
      this.ensureStats(player.id)
      this.log(
        'system',
        `${player.name} joins the table with ${table.buyIn} chips` +
          `${player.reasoningEffort === 'default' ? '' : ` (${player.reasoningEffort} reasoning effort)`}.`
      )
    }

    // A model already at the table keeps the settings it sat down with: a
    // different reasoning effort is effectively a different player.
    const seatedNow = new Set(table.seats().map((seat) => seat.id))
    this.roster = desired.map((player) => {
      const existing = this.roster.find((p) => p.id === player.id)
      return seatedNow.has(player.id) && existing ? existing : player
    })
  }

  private pokerRoster(table: PokerTable): RosterTable {
    return {
      seats: () =>
        table.state.seats.map((seat) => ({ id: seat.id, name: seat.name, chips: seat.stack })),
      capacity: GAMES.poker.maxPlayers,
      buyIn: this.settings.poker.startingStack,
      add: (player, buyIn) =>
        table.addSeat({ id: player.id, name: player.name, modelId: player.modelId }, buyIn),
      remove: (id) => table.removeSeat(id)
    }
  }

  private blackjackRoster(table: BlackjackTable): RosterTable {
    return {
      seats: () =>
        table.state.players.map((player) => ({
          id: player.id,
          name: player.name,
          chips: player.bankroll
        })),
      capacity: GAMES.blackjack.maxPlayers,
      buyIn: this.settings.blackjack.startingBankroll,
      add: (player, buyIn) =>
        table.addPlayer({ id: player.id, name: player.name, modelId: player.modelId }, buyIn),
      remove: (id) => table.removePlayer(id)
    }
  }

  /** The live configuration for a seat, which may differ from the settings. */
  private configFor(playerId: string): PlayerConfig | undefined {
    return this.roster.find((player) => player.id === playerId)
  }

  pause(): void {
    if (this.status !== 'running') return
    this.status = 'paused'
    this.pausePromise = new Promise((resolve) => {
      this.resumeSignal = resolve
    })
    this.log('system', 'Paused.')
    this.pushSnapshot()
  }

  resume(): void {
    if (this.status !== 'paused') return
    this.status = 'running'
    this.resumeSignal?.()
    this.pausePromise = null
    this.resumeSignal = null
    this.log('system', 'Resumed.')
    this.pushSnapshot()
  }

  stop(): void {
    if (this.status === 'finished' || this.status === 'idle') return
    this.status = 'stopping'
    this.resumeSignal?.()
    this.abort.abort()
    this.pushSnapshot()
  }

  get isStopping(): boolean {
    return this.status === 'stopping' || this.abort.signal.aborted
  }

  /* ----------------------------------------------------------- event glue */

  private log(level: LogLevel, text: string, playerId?: string): void {
    const entry: LogEntry = { id: ++this.logSeq, ts: Date.now(), level, text, playerId }
    this.emit({ type: 'log', entry })
  }

  private snapshot(): MatchSnapshot {
    return {
      status: this.status,
      game: this.settings.game,
      blackjack: this.blackjack ? structuredClone(this.blackjack.state) : undefined,
      poker: this.poker ? structuredClone(this.poker.state) : undefined,
      players: this.roster,
      stats: [...this.stats.values()].map(({ latencyTotal, ...rest }) => ({
        ...rest,
        avgLatencyMs: rest.decisions ? Math.round(latencyTotal / rest.decisions) : 0
      })),
      errorText: this.errorText
    }
  }

  private pushSnapshot(): void {
    this.emit({ type: 'snapshot', snapshot: this.snapshot() })
  }

  private recordDecision(
    player: PlayerConfig,
    actionLabel: string,
    result: {
      reasoning: string
      attempts: number
      fallbackReason?: string
      latencyMs: number
      promptTokens: number
      completionTokens: number
      costUsd: number
    }
  ): void {
    const stats = this.stats.get(player.id)
    if (stats) {
      stats.decisions++
      stats.promptTokens += result.promptTokens
      stats.completionTokens += result.completionTokens
      stats.costUsd += result.costUsd
      stats.latencyTotal += result.latencyMs
      if (result.fallbackReason) stats.fallbacks++
      if (result.attempts > 1) stats.errors += result.attempts - 1
    }

    const record: DecisionRecord = {
      id: ++this.decisionSeq,
      ts: Date.now(),
      playerId: player.id,
      playerName: player.name,
      modelId: player.modelId,
      reasoning: result.reasoning,
      actionLabel,
      latencyMs: result.latencyMs,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costUsd: result.costUsd,
      fallback: result.fallbackReason,
      attempts: result.attempts
    }
    this.emit({ type: 'decision', record })
  }

  /**
   * Ends the match when a failure will repeat on every call, rather than
   * letting every remaining decision quietly fall back.
   */
  private failFast(result: { fatalReason?: string }): void {
    if (result.fatalReason) throw new Error(result.fatalReason)
  }

  /** Waits out the visible step delay, returning early if the match stops. */
  private async beat(multiplier = 1): Promise<void> {
    await this.gate()
    const ms = Math.round(this.live.stepDelayMs * multiplier)
    if (ms <= 0 || this.isStopping) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      this.abort.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  /** Blocks while the match is paused. */
  private async gate(): Promise<void> {
    while (this.pausePromise && !this.isStopping) {
      await this.pausePromise
    }
  }

  /* ------------------------------------------------------------- run loop */

  async run(): Promise<void> {
    this.status = 'running'
    this.pushSnapshot()

    try {
      if (this.settings.game === 'blackjack') await this.runBlackjack()
      else await this.runPoker()

      const wasStopped = this.abort.signal.aborted
      this.status = 'finished'
      this.log('system', wasStopped ? 'Match stopped.' : 'Match over.')
    } catch (error) {
      this.status = 'error'
      this.errorText = (error as Error).message
      this.log('error', `Match stopped: ${this.errorText}`)
    }
    this.pushSnapshot()
  }

  /* ---------------------------------------------------------- blackjack */

  private async runBlackjack(): Promise<void> {
    const limits = GAMES.blackjack
    if (this.roster.length < limits.minPlayers) {
      throw new Error('Add a model to the table before starting.')
    }
    if (this.roster.length > limits.maxPlayers) {
      throw new Error(`Blackjack seats at most ${limits.maxPlayers} models.`)
    }

    const rules = this.settings.blackjack
    const table = new BlackjackTable(
      rules,
      this.roster.map((p) => ({ id: p.id, name: p.name, modelId: p.modelId }))
    )
    this.blackjack = table

    this.log(
      'system',
      this.roster.length === 1
        ? `${this.roster[0].name} sits down with ${rules.startingBankroll} chips, betting ${rules.baseBet} a hand.`
        : `${this.roster.length} models sit down with ${rules.startingBankroll} chips each, ` +
          `betting ${rules.baseBet} a hand and sharing one ${rules.deckCount}-deck shoe.`
    )
    this.pushSnapshot()

    while (!this.isStopping) {
      const maxRounds = this.live.maxRounds
      if (maxRounds > 0 && table.state.roundsPlayed >= maxRounds) break

      await this.gate()
      if (this.isStopping) break

      // Seats join or leave here, at the boundary between rounds.
      this.reconcileRoster(this.blackjackRoster(table))
      if (table.state.players.length === 0) {
        this.log('result', 'Nobody is left at the table, so the game ends.')
        break
      }

      // Picked up here so a stake change lands on the next deal, never mid-hand.
      table.setBaseBet(this.live.blackjackBaseBet)
      // The engine reports the transition, so a seat that went broke in round 7
      // is not re-announced in every round after it.
      for (const retired of table.retireBrokePlayers()) {
        this.log(
          'result',
          `${retired.name} is out of chips after ${retired.roundsPlayed} rounds.`,
          retired.id
        )
      }
      if (table.isTableBroke) {
        // The line above already named the only seat, so this would just repeat
        // it back at a one-seat table.
        if (table.state.players.length > 1) {
          this.log('result', `Nobody can cover the stake after ${table.state.roundsPlayed} rounds.`)
        }
        break
      }

      const wagers = await this.collectWagers(table)
      if (this.isStopping) break

      const resolvedOnDeal = table.startRound(wagers)
      if (table.state.shoeJustShuffled) this.log('system', 'The shoe is reshuffled.')

      this.log(
        'deal',
        `Round ${table.state.roundNumber}: dealer shows ${cardCode(table.state.dealerCards[0])}.`
      )
      for (const seat of table.activePlayers) {
        const hand = seat.hands[0]
        if (!hand) continue
        this.log(
          'deal',
          `${seat.name} bets ${hand.bet} and is dealt ${hand.cards.map(cardCode).join(' ')} ` +
            `(${describeValue(hand.cards)}).`,
          seat.id
        )
      }
      this.pushSnapshot()
      await this.beat()

      let resolved = resolvedOnDeal
      if (table.awaitingInsurance && !this.isStopping) {
        resolved = await this.offerInsurance(table)
      }
      if (this.isStopping) break

      for (const seat of table.activePlayers) {
        if (seat.hands[0]?.status === 'blackjack') {
          this.log('result', `${seat.name} has blackjack!`, seat.id)
        }
      }

      if (!resolved) {
        // Six seats, four split hands each and a long run of hits is still far
        // inside this bound; it exists only to stop a wedged engine spinning.
        let guard = 0
        while (table.awaitingPlayer && !this.isStopping && guard++ < 500) {
          await this.gate()
          if (this.isStopping) break
          await this.playBlackjackTurn(table)
        }
      }

      if (this.isStopping) break

      const drawn = table.playDealerTurn()
      const dealerCards = table.state.dealerCards.map(cardCode).join(' ')
      this.log(
        'deal',
        drawn.length
          ? `Dealer reveals and draws ${drawn.map(cardCode).join(' ')} — ${dealerCards} (${describeValue(table.state.dealerCards)}).`
          : `Dealer shows ${dealerCards} (${describeValue(table.state.dealerCards)}).`
      )
      this.pushSnapshot()
      await this.beat()

      table.settle()
      this.reportRound(table)
      this.pushSnapshot()
      await this.beat(1.4)
    }
  }

  /** Logs what every seat did with the round that just settled. */
  private reportRound(table: BlackjackTable): void {
    for (const seat of table.state.players) {
      if (seat.insuranceBet > 0) {
        this.log(
          'result',
          seat.insuranceOutcome === 'won'
            ? `Insurance pays 2:1 — ${seat.name} collects ${seat.insuranceBet * 2} on the side bet.`
            : `Insurance loses — ${seat.name} is down ${seat.insuranceBet} on the side bet.`,
          seat.id
        )
      }
      for (const hand of seat.hands) {
        const net = hand.net ?? 0
        const verdict =
          hand.outcome === 'blackjack' ? 'wins with blackjack' :
          hand.outcome === 'win' ? 'wins' :
          hand.outcome === 'push' ? 'pushes' : 'loses'
        this.log(
          'result',
          `${seat.name} ${verdict} ${net === 0 ? '' : `${net > 0 ? '+' : ''}${net} `}` +
            `(${hand.cards.map(cardCode).join(' ')} = ${describeValue(hand.cards)}).`,
          seat.id
        )
      }
    }

    const dealt = table.state.players.filter((seat) => seat.hands.length > 0)
    if (dealt.length === 1) {
      const seat = dealt[0]
      this.log(
        'result',
        `Bankroll: ${seat.bankroll} chips (session ${seat.sessionNet >= 0 ? '+' : ''}${seat.sessionNet}).`,
        seat.id
      )
    } else if (dealt.length > 1) {
      this.log(
        'result',
        'Bankrolls — ' +
          dealt
            .map((seat) => `${seat.name} ${seat.bankroll} (${seat.sessionNet >= 0 ? '+' : ''}${seat.sessionNet})`)
            .join('; ') +
          '.'
      )
    }
  }

  /**
   * Runs the insurance offer, seat by seat, when the dealer shows an ace.
   * Returns true when the resulting peek ended the round outright.
   */
  private async offerInsurance(table: BlackjackTable): Promise<boolean> {
    for (;;) {
      const seat = table.insuranceSeat
      if (!seat || this.isStopping) break
      const player = this.configFor(seat.id)
      if (!player) {
        table.takeInsurance(seat.id, false)
        continue
      }

      const cost = seat.insuranceOffer
      const prompt = buildBlackjackInsurancePrompt(table.state, seat, cost, this.settings.blackjack)

      this.emit({ type: 'thinking', playerId: player.id, playerName: player.name, active: true })
      const result = await requestDecision<boolean>({
        apiKey: this.apiKey,
        player,
        prompt,
        parse: parseBlackjackInsuranceReply,
        // Declining is the safe default: insurance is a losing bet on average.
        fallback: false,
        signal: this.abort.signal,
        onAttemptFailed: (attempt, problem) =>
          this.log('error', `${player.name} attempt ${attempt} rejected: ${problem}`, player.id)
      })
      this.emit({ type: 'thinking', playerId: player.id, playerName: player.name, active: false })

      if (this.isStopping) return false
      this.failFast(result)

      if (result.fallbackReason) {
        this.log(
          'error',
          `${player.name} could not answer the insurance offer (${result.fallbackReason}) — declining.`,
          player.id
        )
      }

      const took = result.action
      this.recordDecision(player, took ? 'takes insurance' : 'declines insurance', result)
      this.log(
        'action',
        took
          ? `${player.name} takes insurance for ${cost} chips.`
          : `${player.name} declines insurance.`,
        player.id
      )
      table.takeInsurance(seat.id, took)
      this.pushSnapshot()
      await this.beat(0.5)
    }

    if (this.isStopping) return false
    const resolved = table.closeInsurance()
    this.pushSnapshot()
    await this.beat()
    return resolved
  }

  /** Sizes every seat's wager before the cards come out. */
  private async collectWagers(table: BlackjackTable): Promise<Record<string, number>> {
    const wagers: Record<string, number> = {}
    if (!this.live.modelChoosesBet) return wagers

    for (const seat of table.activePlayers) {
      if (this.isStopping) break
      const player = this.configFor(seat.id)
      if (!player) continue
      wagers[seat.id] = await this.chooseBlackjackWager(player, table, seat)
    }
    return wagers
  }

  /** Asks the model to size its own wager before the cards come out. */
  private async chooseBlackjackWager(
    player: PlayerConfig,
    table: BlackjackTable,
    seat: BlackjackPlayer
  ): Promise<number> {
    const limits = table.betLimits(seat)
    if (limits.min >= limits.max) return limits.min

    const prompt = buildBlackjackBetPrompt(table.state, seat, limits, this.settings.blackjack)

    this.emit({ type: 'thinking', playerId: player.id, playerName: player.name, active: true })
    const result = await requestDecision<number>({
      apiKey: this.apiKey,
      player,
      prompt,
      parse: (text) => parseBlackjackBetReply(text, limits),
      // The table minimum is the safe default: it keeps the session alive.
      fallback: limits.min,
      signal: this.abort.signal,
      onAttemptFailed: (attempt, problem) =>
        this.log('error', `${player.name} attempt ${attempt} rejected: ${problem}`, player.id)
    })
    this.emit({ type: 'thinking', playerId: player.id, playerName: player.name, active: false })

    if (this.isStopping) return limits.min
    this.failFast(result)

    if (result.fallbackReason) {
      this.log(
        'error',
        `${player.name} could not size a bet (${result.fallbackReason}) — betting the minimum ${limits.min}.`,
        player.id
      )
    }
    this.recordDecision(player, `bets ${result.action}`, result)
    return result.action
  }

  private async playBlackjackTurn(table: BlackjackTable): Promise<void> {
    const seat = table.activePlayer
    if (!seat) return
    const player = this.configFor(seat.id)
    if (!player) throw new Error(`No model configured for seat ${seat.name}.`)

    const legal = table.legalActions()
    if (!legal.length) return

    const prompt = buildBlackjackPrompt(table.state, seat, legal, this.settings.blackjack)

    this.emit({ type: 'thinking', playerId: player.id, playerName: player.name, active: true })
    const result = await requestDecision<BlackjackAction>({
      apiKey: this.apiKey,
      player,
      prompt,
      parse: (text) => parseBlackjackReply(text, legal),
      // Standing is the safe default: it never busts and never costs extra chips.
      fallback: 'stand',
      signal: this.abort.signal,
      onAttemptFailed: (attempt, problem) =>
        this.log('error', `${player.name} attempt ${attempt} rejected: ${problem}`, player.id)
    })
    this.emit({ type: 'thinking', playerId: player.id, playerName: player.name, active: false })

    if (this.isStopping) return
    this.failFast(result)

    if (result.fallbackReason) {
      this.log('error', `${player.name} could not answer (${result.fallbackReason}) — standing by default.`, player.id)
    }

    const before = table.activeHand
    const label = table.applyAction(result.action)
    const after = before ? before.cards.map(cardCode).join(' ') : ''

    this.recordDecision(player, result.action, result)
    this.log(
      'action',
      `${player.name} ${label}` + (after ? ` — ${after} (${describeValue(before!.cards)})` : ''),
      player.id
    )
    if (before?.status === 'busted') this.log('result', `${player.name} busts.`, player.id)

    this.pushSnapshot()
    await this.beat()
  }

  /* -------------------------------------------------------------- poker */

  private async runPoker(): Promise<void> {
    const players = this.roster
    const limits = GAMES.poker
    if (players.length < limits.minPlayers) {
      throw new Error(`Poker needs at least ${limits.minPlayers} models at the table.`)
    }
    if (players.length > limits.maxPlayers) {
      throw new Error(`Poker supports at most ${limits.maxPlayers} models.`)
    }

    const rules = this.settings.poker
    const table = new PokerTable(
      players.map((p) => ({ id: p.id, name: p.name, modelId: p.modelId })),
      rules
    )
    this.poker = table

    this.log('system', `${players.length} models sit down with ${rules.startingStack} chips each. Blinds ${rules.smallBlind}/${rules.bigBlind}.`)
    this.pushSnapshot()

    /** Seats already announced as out, so each is reported exactly once. */
    const eliminated = new Set<string>()

    while (!this.isStopping && !table.isMatchOver) {
      const maxHands = this.live.maxRounds
      if (maxHands > 0 && table.state.handsPlayed >= maxHands) break

      await this.gate()
      if (this.isStopping) break

      // Seats join or leave here, at the boundary between hands.
      this.reconcileRoster(this.pokerRoster(table))
      if (table.state.seats.filter((seat) => !seat.busted).length < 2) {
        this.log('result', 'Fewer than two players remain, so the table closes.')
        break
      }

      table.startHand()
      // Equity moves only when the board changes or someone folds, never with
      // the betting, so it is refreshed at exactly those three points. Each
      // refresh lands just before a step delay, which absorbs the cost.
      if (this.live.showEquity) table.refreshEquity()
      const history: string[] = []
      const sb = table.state.seats.find((s) => s.lastActionLabel === 'SB')
      const bb = table.state.seats.find((s) => s.lastActionLabel === 'BB')
      this.log(
        'deal',
        `Hand ${table.state.handNumber}: ${sb?.name ?? '?'} posts ${table.state.smallBlind}, ` +
          `${bb?.name ?? '?'} posts ${table.state.bigBlind}.`
      )
      this.pushSnapshot()
      await this.beat()

      let guard = 0
      let step: PokerStep = table.step()
      while (!this.isStopping && step.kind !== 'handComplete') {
        if (++guard > 500) throw new Error('The poker hand did not terminate.')

        if (step.kind === 'await') {
          await this.gate()
          if (this.isStopping) break
          await this.playPokerTurn(table, step.seatIndex, history)
        } else if (step.kind === 'street') {
          const board = table.state.board.map(cardCode).join(' ')
          this.log('deal', `${capitalise(step.street)}: ${step.cards.map(cardCode).join(' ')}  —  board ${board}`)
          history.push(`${step.street} (${board})`)
          if (this.live.showEquity) table.refreshEquity()
          this.pushSnapshot()
          await this.beat()
        } else if (step.kind === 'payout') {
          if (step.showdown) {
            for (const seat of table.state.seats.filter((s) => s.cardsRevealed)) {
              this.log('result', `${seat.name} shows ${seat.cards.map(cardCode).join(' ')} — ${seat.showdownHand}.`, seat.id)
            }
          }
          for (const award of step.awards) {
            this.log(
              'result',
              `${award.seatName} wins ${award.amount} chips` +
                (award.handLabel ? ` with ${uncapitalise(award.handLabel)}` : '') +
                (table.state.sidePots.length > 1 ? ` (pot ${award.potIndex + 1})` : '') +
                '.',
              award.seatId
            )
          }
          // Announce the transition, not the state: this runs after every
          // payout, so without the guard each already-busted seat was
          // re-eliminated in the log once per hand for the rest of the match.
          for (const seat of table.state.seats) {
            if (seat.busted && seat.stack === 0 && !eliminated.has(seat.id)) {
              eliminated.add(seat.id)
              this.log('result', `${seat.name} is eliminated.`, seat.id)
            }
          }
          this.pushSnapshot()
          await this.beat(1.6)
        }

        step = table.step()
      }

      this.pushSnapshot()
    }

    if (table.isMatchOver) {
      this.log('result', `${table.winnerName} wins the table with all ${table.state.seats.reduce((n, s) => n + s.stack, 0)} chips.`)
    }
  }

  private async playPokerTurn(
    table: PokerTable,
    seatIndex: number,
    history: string[]
  ): Promise<void> {
    const seat = table.state.seats[seatIndex]
    const player = this.roster.find((p) => p.id === seat.id)
    if (!player) throw new Error(`No model configured for seat ${seat.name}.`)

    const legal = table.legalActions()
    const prompt = buildPokerPrompt(table, seatIndex, legal, history, this.settings.poker)

    this.emit({ type: 'thinking', playerId: player.id, playerName: player.name, active: true })
    const result = await requestDecision<PokerAction>({
      apiKey: this.apiKey,
      player,
      prompt,
      parse: (text) => parsePokerReply(text, legal),
      // Checking when free, folding otherwise: never risks chips on a bad reply.
      fallback: legal.canCheck ? { kind: 'check' } : { kind: 'fold' },
      signal: this.abort.signal,
      onAttemptFailed: (attempt, problem) =>
        this.log('error', `${player.name} attempt ${attempt} rejected: ${problem}`, player.id)
    })
    this.emit({ type: 'thinking', playerId: player.id, playerName: player.name, active: false })

    if (this.isStopping) return
    this.failFast(result)

    if (result.fallbackReason) {
      this.log(
        'error',
        `${player.name} could not answer (${result.fallbackReason}) — ${legal.canCheck ? 'checking' : 'folding'} by default.`,
        player.id
      )
    }

    const label = table.applyAction(result.action)
    this.recordDecision(player, label, result)
    this.log('action', `${player.name} ${label}.`, player.id)
    history.push(`${seat.name} ${label}`)

    // A fold redistributes everyone else's chances, so the numbers are
    // recomputed *before* the snapshot that carries the fold. Refreshing after
    // it left the new figures sitting in state with nothing to deliver them:
    // the UI kept the pre-fold percentages until the next player acted.
    if (result.action.kind === 'fold' && this.live.showEquity) table.refreshEquity()

    this.pushSnapshot()
    await this.beat()
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
