import { GAMES } from '../../shared/types.ts'
import type {
  DecisionRecord,
  GameKind,
  LogEntry,
  LogLevel,
  MatchEvent,
  MatchSettings,
  MatchSnapshot,
  MatchStatus,
  PlayerConfig,
  PlayerStats
} from '../../shared/types.ts'
import { requestDecision, type AgentResult } from './agent.ts'
import type { AskRequest, DriverContext, GameDriver, LiveSettings, RosterTable } from './driver.ts'
import { BlackjackDriver } from './drivers/blackjack.ts'
import { HeartsDriver } from './drivers/hearts.ts'
import { PokerDriver } from './drivers/poker.ts'
import { TwentyFourDriver } from './drivers/twentyfour.ts'

export type Emit = (event: MatchEvent) => void

interface StatsAccumulator extends PlayerStats {
  latencyTotal: number
}

type DriverClass = new (ctx: DriverContext, settings: MatchSettings) => GameDriver

/**
 * Partial on purpose. A game listed in `GAMES` but missing here fails loudly at
 * the first deal; mapping it to some other game's driver as a placeholder would
 * quietly play the wrong game.
 */
const DRIVERS: Partial<Record<GameKind, DriverClass>> = {
  blackjack: BlackjackDriver,
  poker: PokerDriver,
  hearts: HeartsDriver,
  twentyfour: TwentyFourDriver
}

/**
 * Drives a match: owns the clock, the pause gate, the network, the stats and the
 * event stream. What it deliberately does *not* own is any game's rules — those
 * live behind `GameDriver`, one per game, so adding a game does not grow this
 * file.
 */
export class MatchRunner {
  private status: MatchStatus = 'idle'
  private readonly abort = new AbortController()
  private pausePromise: Promise<void> | null = null
  private resumeSignal: (() => void) | null = null
  private logSeq = 0
  private decisionSeq = 0
  private errorText?: string

  private driver: GameDriver | null = null
  private readonly stats = new Map<string, StatsAccumulator>()

  /**
   * Settings the operator may change while a match is running. Everything else
   * is fixed when the match starts, because changing it mid-game would
   * invalidate the table state.
   */
  private live: LiveSettings

  /** The players currently at the table; seats can change between rounds. */
  private players: PlayerConfig[]
  /** A roster change waiting to be applied at the next round boundary. */
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
    this.players = [...settings.players]
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
    if (this.driver?.kind === 'blackjack' && this.live.blackjackBaseBet !== previousBet) {
      this.log(
        'system',
        `Stake changed from ${previousBet} to ${this.live.blackjackBaseBet}, starting next round.`
      )
    }

    // Seats may be added or removed, but only at a round boundary — never with
    // cards dealt or chips already in a pot. A fixed-roster game never changes
    // at all, so it is not offered the chance.
    if (!this.driver || GAMES[this.settings.game].fixedRoster) return
    const seated = seatedIds(this.driver)
    if (seated) this.queueRosterChange(next.players, seated)
  }

  /** Holds a roster change until the next round boundary. */
  private queueRosterChange(desired: PlayerConfig[], seated: Set<string>): void {
    const differs =
      desired.length !== this.players.length ||
      desired.some((p, i) => {
        const current = this.players[i]
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
        !this.players.some((existing) => existing.id === p.id)
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
    this.players = desired.map((player) => {
      const existing = this.players.find((p) => p.id === player.id)
      return seatedNow.has(player.id) && existing ? existing : player
    })
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
      table: this.driver ? structuredClone(this.driver.state) : null,
      players: this.players,
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
    result: AgentResult<unknown>
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
   * One decision, with the spinner, the retry logging and the fatal-error check
   * wired up. Every call site used to repeat all three.
   */
  private async ask<T>(request: AskRequest<T>): Promise<AgentResult<T>> {
    const { player, prompt, parse, fallback, failFast = true } = request

    this.emit({ type: 'thinking', playerId: player.id, playerName: player.name, active: true })
    try {
      const result = await requestDecision<T>({
        apiKey: this.apiKey,
        player,
        prompt,
        parse,
        fallback,
        signal: this.abort.signal,
        onAttemptFailed: (attempt, problem) =>
          this.log('error', `${player.name} attempt ${attempt} rejected: ${problem}`, player.id)
      })

      // 401/402/403 would fail identically on every later call, so absorbing
      // them as fallbacks produces a table where every decision silently
      // degrades. A simultaneous round opts out and rethrows for itself.
      if (failFast && result.fatalReason) throw new Error(result.fatalReason)
      return result
    } finally {
      this.emit({ type: 'thinking', playerId: player.id, playerName: player.name, active: false })
    }
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

  /** Everything a driver is allowed to reach out of its own game for. */
  private context(): DriverContext {
    const runner = this
    return {
      get isStopping() {
        return runner.isStopping
      },
      get live() {
        return runner.live
      },
      get roster() {
        return runner.players
      },
      log: (level, text, playerId) => runner.log(level, text, playerId),
      beat: (multiplier) => runner.beat(multiplier),
      gate: () => runner.gate(),
      pushSnapshot: () => runner.pushSnapshot(),
      pause: () => runner.pause(),
      configFor: (playerId) => runner.players.find((player) => player.id === playerId),
      ensureStats: (playerId) => runner.ensureStats(playerId),
      reconcileRoster: (table) => runner.reconcileRoster(table),
      ask: (request) => runner.ask(request),
      recordDecision: (player, label, result) => runner.recordDecision(player, label, result)
    }
  }

  /* ------------------------------------------------------------- run loop */

  async run(): Promise<void> {
    this.status = 'running'
    this.pushSnapshot()

    try {
      const Driver = DRIVERS[this.settings.game]
      if (!Driver) throw new Error(`${GAMES[this.settings.game].label} is not playable yet.`)

      const driver = new Driver(this.context(), this.settings)
      driver.start()
      this.driver = driver
      this.pushSnapshot()

      while (!this.isStopping) {
        const maxRounds = this.live.maxRounds
        if (maxRounds > 0 && driver.roundsPlayed >= maxRounds) break

        await this.gate()
        if (this.isStopping) break

        if ((await driver.playRound()) === 'ended') break
      }

      driver.finish()

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
}

/** The ids of everyone actually dealt in, whatever the game calls its seats. */
function seatedIds(driver: GameDriver): Set<string> | null {
  const state = driver.state
  switch (state.kind) {
    case 'blackjack':
      return new Set(state.players.map((player) => player.id))
    case 'poker':
      return new Set(state.seats.map((seat) => seat.id))
    case 'hearts':
      return new Set(state.players.map((player) => player.id))
    case 'twentyfour':
      return new Set(state.players.map((player) => player.id))
  }
}
