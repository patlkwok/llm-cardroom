import { cardCode } from '../../../shared/cards.ts'
import { GAMES } from '../../../shared/types.ts'
import type { MatchSettings, PokerAction, PokerState } from '../../../shared/types.ts'
import type { DriverContext, GameDriver, RosterTable } from '../driver.ts'
import { PokerTable, type PokerStep } from '../poker/engine.ts'
import { uncapitalise } from '../poker/handEval.ts'
import { buildPokerPrompt, parsePokerReply } from '../prompts/poker.ts'

export class PokerDriver implements GameDriver {
  readonly kind = 'poker' as const
  private table!: PokerTable
  /** Seats already announced as out, so each is reported exactly once. */
  private readonly eliminated = new Set<string>()

  constructor(
    private readonly ctx: DriverContext,
    private readonly settings: MatchSettings
  ) {}

  get state(): PokerState {
    return this.table.state
  }

  get roundsPlayed(): number {
    return this.table.state.handsPlayed
  }

  start(): void {
    const limits = GAMES.poker
    const players = this.ctx.roster
    if (players.length < limits.minPlayers) {
      throw new Error(`Poker needs at least ${limits.minPlayers} models at the table.`)
    }
    if (players.length > limits.maxPlayers) {
      throw new Error(`Poker supports at most ${limits.maxPlayers} models.`)
    }

    const rules = this.settings.poker
    this.table = new PokerTable(
      players.map((p) => ({ id: p.id, name: p.name, modelId: p.modelId })),
      rules
    )

    this.ctx.log(
      'system',
      `${players.length} models sit down with ${rules.startingStack} chips each. ` +
        `Blinds ${rules.smallBlind}/${rules.bigBlind}.`
    )
  }

  finish(): void {
    if (!this.table?.isMatchOver) return
    const chips = this.table.state.seats.reduce((n, s) => n + s.stack, 0)
    this.ctx.log('result', `${this.table.winnerName} wins the table with all ${chips} chips.`)
  }

  private rosterTable(): RosterTable {
    const table = this.table
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

  async playRound(): Promise<'played' | 'ended'> {
    const ctx = this.ctx
    const table = this.table
    if (table.isMatchOver) return 'ended'

    // Seats join or leave here, at the boundary between hands.
    ctx.reconcileRoster(this.rosterTable())
    if (table.state.seats.filter((seat) => !seat.busted).length < 2) {
      ctx.log('result', 'Fewer than two players remain, so the table closes.')
      return 'ended'
    }

    table.startHand()
    // Equity moves only when the board changes or someone folds, never with
    // the betting, so it is refreshed at exactly those three points. Each
    // refresh lands just before a step delay, which absorbs the cost.
    if (ctx.live.showEquity) table.refreshEquity()
    const history: string[] = []
    const sb = table.state.seats.find((s) => s.lastActionLabel === 'SB')
    const bb = table.state.seats.find((s) => s.lastActionLabel === 'BB')
    ctx.log(
      'deal',
      `Hand ${table.state.handNumber}: ${sb?.name ?? '?'} posts ${table.state.smallBlind}, ` +
        `${bb?.name ?? '?'} posts ${table.state.bigBlind}.`
    )
    ctx.pushSnapshot()
    await ctx.beat()

    let guard = 0
    let step: PokerStep = table.step()
    while (!ctx.isStopping && step.kind !== 'handComplete') {
      if (++guard > 500) throw new Error('The poker hand did not terminate.')

      if (step.kind === 'await') {
        await ctx.gate()
        if (ctx.isStopping) break
        await this.playTurn(step.seatIndex, history)
      } else if (step.kind === 'street') {
        const board = table.state.board.map(cardCode).join(' ')
        ctx.log('deal', `${capitalise(step.street)}: ${step.cards.map(cardCode).join(' ')}  —  board ${board}`)
        history.push(`${step.street} (${board})`)
        if (ctx.live.showEquity) table.refreshEquity()
        ctx.pushSnapshot()
        await ctx.beat()
      } else if (step.kind === 'payout') {
        if (step.showdown) {
          for (const seat of table.state.seats.filter((s) => s.cardsRevealed)) {
            ctx.log('result', `${seat.name} shows ${seat.cards.map(cardCode).join(' ')} — ${seat.showdownHand}.`, seat.id)
          }
        }
        for (const award of step.awards) {
          ctx.log(
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
          if (seat.busted && seat.stack === 0 && !this.eliminated.has(seat.id)) {
            this.eliminated.add(seat.id)
            ctx.log('result', `${seat.name} is eliminated.`, seat.id)
          }
        }
        ctx.pushSnapshot()
        await ctx.beat(1.6)
      }

      step = table.step()
    }

    ctx.pushSnapshot()
    return 'played'
  }

  private async playTurn(seatIndex: number, history: string[]): Promise<void> {
    const ctx = this.ctx
    const table = this.table
    const seat = table.state.seats[seatIndex]
    const player = ctx.configFor(seat.id)
    if (!player) throw new Error(`No model configured for seat ${seat.name}.`)

    const legal = table.legalActions()
    const result = await ctx.ask<PokerAction>({
      player,
      prompt: buildPokerPrompt(table, seatIndex, legal, history, this.settings.poker),
      parse: (text) => parsePokerReply(text, legal),
      // Checking when free, folding otherwise: never risks chips on a bad reply.
      fallback: legal.canCheck ? { kind: 'check' } : { kind: 'fold' }
    })
    if (ctx.isStopping) return

    if (result.fallbackReason) {
      ctx.log(
        'error',
        `${player.name} could not answer (${result.fallbackReason}) — ${legal.canCheck ? 'checking' : 'folding'} by default.`,
        player.id
      )
    }

    const label = table.applyAction(result.action)
    ctx.recordDecision(player, label, result)
    ctx.log('action', `${player.name} ${label}.`, player.id)
    history.push(`${seat.name} ${label}`)

    // A fold redistributes everyone else's chances, so the numbers are
    // recomputed *before* the snapshot that carries the fold. Refreshing after
    // it left the new figures sitting in state with nothing to deliver them:
    // the UI kept the pre-fold percentages until the next player acted.
    if (result.action.kind === 'fold' && ctx.live.showEquity) table.refreshEquity()

    ctx.pushSnapshot()
    await ctx.beat()
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
