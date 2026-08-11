import { cardCode } from '../../shared/cards.ts'
import type {
  BlackjackAction,
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

    // Poker seats may be added or removed, but only at a hand boundary.
    if (this.settings.game === 'poker' && this.poker) {
      const seated = new Set(this.poker.state.seats.map((seat) => seat.id))
      const arriving = next.players.filter((p) => !seated.has(p.id))
      const differs =
        next.players.length !== this.roster.length ||
        next.players.some((p, i) => {
          const current = this.roster[i]
          if (!current || p.id !== current.id) return true
          // A seated model is fixed for the match; only an unseated one may
          // still have its reasoning effort adjusted.
          return !seated.has(p.id) && p.reasoningEffort !== current.reasoningEffort
        })

      if (differs) {
        this.pendingRoster = [...next.players]

        // Give the operator a chance to set the newcomer up before it is dealt
        // in, rather than racing the next hand at whatever pace is set.
        const newcomers = arriving.filter(
          (p) => !this.roster.some((existing) => existing.id === p.id)
        )
        if (newcomers.length > 0 && this.status === 'running') {
          this.pause()
          this.log(
            'system',
            `${newcomers.map((p) => p.name).join(', ')} will join next hand. ` +
              'Set their reasoning effort now, then resume.'
          )
        }
      }
    }
  }

  /**
   * Applies a queued roster change. Only ever called between hands, so no seat
   * is ever added or removed with chips committed to a live pot.
   */
  private reconcilePokerRoster(table: PokerTable): void {
    const desired = this.pendingRoster
    if (!desired) return
    this.pendingRoster = null

    for (const seat of [...table.state.seats]) {
      if (desired.some((p) => p.id === seat.id)) continue
      const chips = seat.stack
      if (table.removeSeat(seat.id)) {
        this.log('system', `${seat.name} leaves the table, taking ${chips} chips.`)
      }
    }

    for (const player of desired) {
      if (table.state.seats.some((seat) => seat.id === player.id)) continue
      if (table.state.seats.length >= 8) {
        this.log('error', `${player.name} cannot join: the table is full at 8 seats.`)
        continue
      }
      const stack = this.settings.poker.startingStack
      table.addSeat({ id: player.id, name: player.name, modelId: player.modelId }, stack)
      this.ensureStats(player.id)
      this.log(
        'system',
        `${player.name} joins the table with ${stack} chips` +
          `${player.reasoningEffort === 'default' ? '' : ` (${player.reasoningEffort} reasoning effort)`}.`
      )
    }

    // A model already at the table keeps the settings it sat down with: a
    // different reasoning effort is effectively a different player.
    this.roster = desired.map((player) => {
      const wasSeated = table.state.seats.some((seat) => seat.id === player.id)
      const existing = this.roster.find((p) => p.id === player.id)
      return wasSeated && existing ? existing : player
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
    const player = this.settings.players[0]
    if (!player) throw new Error('Add a model to the table before starting.')

    const rules = this.settings.blackjack
    const table = new BlackjackTable(rules)
    this.blackjack = table

    this.log('system', `${player.name} sits down with ${rules.startingBankroll} chips, betting ${rules.baseBet} a hand.`)
    this.pushSnapshot()

    while (!this.isStopping) {
      const maxRounds = this.live.maxRounds
      if (maxRounds > 0 && table.state.roundsPlayed >= maxRounds) break
      if (table.isBroke) {
        this.log('result', `${player.name} is out of chips after ${table.state.roundsPlayed} rounds.`)
        break
      }

      await this.gate()
      if (this.isStopping) break

      // Picked up here so a stake change lands on the next deal, never mid-hand.
      table.setBaseBet(this.live.blackjackBaseBet)
      const wager = this.live.modelChoosesBet
        ? await this.chooseBlackjackWager(player, table)
        : undefined
      if (this.isStopping) break

      const resolvedOnDeal = table.startRound(wager)
      if (table.state.shoeJustShuffled) this.log('system', 'The shoe is reshuffled.')

      const hand = table.state.hands[0]
      this.log(
        'deal',
        `Round ${table.state.roundNumber}: ${player.name} bets ${hand.bet} and is dealt ` +
          `${hand.cards.map(cardCode).join(' ')} (${describeValue(hand.cards)}); ` +
          `dealer shows ${cardCode(table.state.dealerCards[0])}.`
      )
      this.pushSnapshot()
      await this.beat()

      let resolved = resolvedOnDeal
      if (table.awaitingInsurance && !this.isStopping) {
        resolved = await this.offerInsurance(player, table)
      }
      if (this.isStopping) break

      if (!resolved) {
        let guard = 0
        while (table.awaitingPlayer && !this.isStopping && guard++ < 40) {
          await this.gate()
          if (this.isStopping) break
          await this.playBlackjackTurn(player, table)
        }
      } else if (hand.status === 'blackjack') {
        this.log('result', `${player.name} has blackjack!`)
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
      if (table.state.insuranceBet > 0) {
        this.log(
          'result',
          table.state.insuranceOutcome === 'won'
            ? `Insurance pays 2:1 — ${player.name} collects ${table.state.insuranceBet * 2} on the side bet.`
            : `Insurance loses — ${player.name} is down ${table.state.insuranceBet} on the side bet.`,
          player.id
        )
      }
      for (const settled of table.state.hands) {
        const net = settled.net ?? 0
        const verdict =
          settled.outcome === 'blackjack' ? 'wins with blackjack' :
          settled.outcome === 'win' ? 'wins' :
          settled.outcome === 'push' ? 'pushes' : 'loses'
        this.log(
          'result',
          `${player.name} ${verdict} ${net === 0 ? '' : `${net > 0 ? '+' : ''}${net} `}` +
            `(${settled.cards.map(cardCode).join(' ')} = ${describeValue(settled.cards)}).`
        )
      }
      this.log(
        'result',
        `Bankroll: ${table.state.bankroll} chips (session ${table.state.sessionNet >= 0 ? '+' : ''}${table.state.sessionNet}).`
      )
      this.pushSnapshot()
      await this.beat(1.4)
    }
  }

  /**
   * Runs the insurance offer when the dealer shows an ace. Returns true when
   * the resulting peek ended the round outright.
   */
  private async offerInsurance(player: PlayerConfig, table: BlackjackTable): Promise<boolean> {
    const cost = table.insuranceCost
    const prompt = buildBlackjackInsurancePrompt(table.state, cost, this.settings.blackjack)

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

    const resolved = table.resolveInsurance(took)
    this.pushSnapshot()
    await this.beat()
    return resolved
  }

  /** Asks the model to size its own wager before the cards come out. */
  private async chooseBlackjackWager(
    player: PlayerConfig,
    table: BlackjackTable
  ): Promise<number> {
    const limits = table.betLimits()
    if (limits.min >= limits.max) return limits.min

    const prompt = buildBlackjackBetPrompt(table.state, limits, this.settings.blackjack)

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

  private async playBlackjackTurn(player: PlayerConfig, table: BlackjackTable): Promise<void> {
    const legal = table.legalActions()
    if (!legal.length) return

    const prompt = buildBlackjackPrompt(table.state, legal, this.settings.blackjack)

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
    const players = this.settings.players
    if (players.length < 2) throw new Error('Poker needs at least 2 models at the table.')
    if (players.length > 8) throw new Error('Poker supports at most 8 models.')

    const rules = this.settings.poker
    const table = new PokerTable(
      players.map((p) => ({ id: p.id, name: p.name, modelId: p.modelId })),
      rules
    )
    this.poker = table

    this.log('system', `${players.length} models sit down with ${rules.startingStack} chips each. Blinds ${rules.smallBlind}/${rules.bigBlind}.`)
    this.pushSnapshot()

    while (!this.isStopping && !table.isMatchOver) {
      const maxHands = this.live.maxRounds
      if (maxHands > 0 && table.state.handsPlayed >= maxHands) break

      await this.gate()
      if (this.isStopping) break

      // Seats join or leave here, at the boundary between hands.
      this.reconcilePokerRoster(table)
      if (table.state.seats.filter((seat) => !seat.busted).length < 2) {
        this.log('result', 'Fewer than two players remain, so the table closes.')
        break
      }

      table.startHand()
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
                (award.handLabel ? ` with ${award.handLabel.toLowerCase()}` : '') +
                (table.state.sidePots.length > 1 ? ` (pot ${award.potIndex + 1})` : '') +
                '.',
              award.seatId
            )
          }
          for (const seat of table.state.seats) {
            if (seat.busted && seat.stack === 0) {
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

    this.pushSnapshot()
    await this.beat()
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
