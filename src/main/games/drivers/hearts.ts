import { cardCode, type Card } from '../../../shared/cards.ts'
import { GAMES } from '../../../shared/types.ts'
import type { HeartsState, HeartsTrick, MatchSettings } from '../../../shared/types.ts'
import type { DriverContext, GameDriver } from '../driver.ts'
import { HeartsTable, HEARTS_SEATS, sortHand } from '../hearts/engine.ts'
import {
  buildHeartsPassPrompt,
  buildHeartsPlayPrompt,
  parseHeartsPassReply,
  parseHeartsPlayReply
} from '../prompts/hearts.ts'

const DIRECTION_PHRASE: Record<string, string> = {
  left: 'left',
  right: 'right',
  across: 'across the table',
  hold: 'nowhere — a hold hand'
}

/**
 * Hearts: four models, thirteen tricks, lowest score wins.
 *
 * Fixed roster by design — it never calls `ctx.reconcileRoster`, so no seat
 * joins or leaves and the whole class of seat-renumbering bugs cannot arise.
 */
export class HeartsDriver implements GameDriver {
  readonly kind = 'hearts' as const
  private table!: HeartsTable
  /** Completed tricks of the hand in progress, for the prompt's history block. */
  private tricks: HeartsTrick[] = []

  constructor(
    private readonly ctx: DriverContext,
    private readonly settings: MatchSettings
  ) {}

  get state(): HeartsState {
    return this.table.state
  }

  get roundsPlayed(): number {
    return this.table.state.handsPlayed
  }

  start(): void {
    const roster = this.ctx.roster
    if (roster.length !== HEARTS_SEATS) {
      throw new Error(
        `${GAMES.hearts.label} needs exactly ${HEARTS_SEATS} models; ${roster.length} are seated.`
      )
    }

    this.table = new HeartsTable(
      roster.map((p) => ({ id: p.id, name: p.name, modelId: p.modelId })),
      this.settings.hearts
    )
    this.ctx.log(
      'system',
      `Four models sit down to Hearts, playing to ${this.settings.hearts.targetScore} points. ` +
        'Lowest score wins.'
    )
  }

  finish(): void {
    const table = this.table
    if (!table) return
    const standings = table.standings
      .map((p) => `${p.name} ${p.totalScore}`)
      .join(', ')
    this.ctx.log('result', `Final scores — ${standings}.`)
    if (table.isMatchOver) {
      this.ctx.log('result', `${table.winnerName} wins with the lowest score.`)
    }
  }

  async playRound(): Promise<'played' | 'ended'> {
    const ctx = this.ctx
    const table = this.table
    if (table.isMatchOver) return 'ended'

    table.startHand()
    this.tricks = []
    ctx.log(
      'deal',
      `Hand ${table.state.handNumber}: 13 cards each, passing ` +
        `${DIRECTION_PHRASE[table.state.passDirection]}.`
    )
    ctx.pushSnapshot()
    await ctx.beat()

    if (table.passing) {
      await this.runPass()
      if (ctx.isStopping) return 'ended'
    }

    ctx.log('deal', `${table.state.players[table.state.leadSeatIndex].name} holds the two of clubs and leads.`)
    ctx.pushSnapshot()
    await ctx.beat()

    // 13 tricks of 4 plays is 52; the bound only stops a wedged engine spinning.
    let guard = 0
    while (!table.handComplete && !ctx.isStopping && guard++ < 200) {
      await ctx.gate()
      if (ctx.isStopping) break
      await this.playOneCard()

      if (table.trickComplete) {
        const trick = table.resolveTrick()
        this.tricks.push(trick)
        ctx.log(
          'result',
          `Trick ${trick.number} to ${trick.winnerName}` +
            (trick.points > 0
              ? ` — ${trick.points} point${trick.points === 1 ? '' : 's'} ` +
                `(${trick.plays.map((p) => cardCode(p.card)).join(' ')}).`
              : ` (${trick.plays.map((p) => cardCode(p.card)).join(' ')}).`),
          trick.winnerSeatIndex === undefined ? undefined : table.state.players[trick.winnerSeatIndex].id
        )

        // The result is its own step: all four cards stay on the felt with the
        // winner marked for a full beat, so the operator can actually read who
        // took the trick and what it cost them. A trick that carries points
        // lingers a little longer, because that is the moment that matters.
        ctx.pushSnapshot()
        await ctx.beat(trick.points > 0 ? 1.5 : 1)

        // Only now are the cards swept up and the next trick led.
        if (table.awaitingNextTrick && !ctx.isStopping) {
          table.startNextTrick()
          ctx.pushSnapshot()
        }
      }
    }

    if (ctx.isStopping) return 'ended'

    const { moonShooter, awarded } = table.scoreHand()
    if (moonShooter) {
      ctx.log(
        'result',
        `${moonShooter.name} SHOT THE MOON — all 26 points. Everybody else takes 26.`,
        moonShooter.id
      )
    }
    for (const { player, points } of awarded) {
      ctx.log(
        'result',
        `${player.name} takes ${points} point${points === 1 ? '' : 's'} ` +
          `(${player.totalScore} total).`,
        player.id
      )
    }
    // Forced plays are free, and the operator should be able to see how much of
    // the hand cost nothing at all.
    const s = table.state
    ctx.log(
      'system',
      `${s.forcedPlays} of ${s.totalPlays} plays so far were forced, and cost no API call.`
    )
    ctx.pushSnapshot()
    await ctx.beat(1.6)

    return table.isMatchOver ? 'ended' : 'played'
  }

  /** Every seat chooses three cards, then they all move at once. */
  private async runPass(): Promise<void> {
    const ctx = this.ctx
    const table = this.table

    for (;;) {
      const seat = table.pendingPassSeat
      if (!seat || ctx.isStopping) break
      const player = ctx.configFor(seat.id)
      if (!player) {
        // No model behind the seat: pass its three highest and move on.
        table.setPass(seat.id, sortHand(seat.hand).slice(-3))
        continue
      }

      const fallback = sortHand(seat.hand).slice(-3)
      const result = await ctx.ask<Card[]>({
        player,
        prompt: buildHeartsPassPrompt(table.state, seat, this.settings.hearts),
        parse: (text) => parseHeartsPassReply(text, seat.hand),
        // Shedding the three highest is a defensible pass and always legal.
        fallback
      })
      if (ctx.isStopping) return

      if (result.fallbackReason) {
        ctx.log(
          'error',
          `${player.name} could not choose a pass (${result.fallbackReason}) — ` +
            `passing ${fallback.map(cardCode).join(' ')}.`,
          player.id
        )
      }

      table.setPass(seat.id, result.action)
      ctx.recordDecision(player, `passes ${result.action.map(cardCode).join(' ')}`, result)
      // The cards themselves stay off the table log: naming them would hand
      // every other seat information it is not entitled to.
      ctx.log('action', `${player.name} passes three cards.`, player.id)
      ctx.pushSnapshot()
      await ctx.beat(0.4)
    }

    if (ctx.isStopping) return
    table.completePass()
    ctx.log('deal', 'Cards are passed and the hands are complete.')
    ctx.pushSnapshot()
    await ctx.beat()
  }

  private async playOneCard(): Promise<void> {
    const ctx = this.ctx
    const table = this.table
    const seat = table.actingPlayer
    if (!seat) return

    const legal = table.legalPlays(seat.seatIndex)
    if (legal.length === 0) return

    // Never ask a model for a forced move. It removes a paid call and its
    // latency, and it removes a failure surface: asking a model to pick from
    // one option can still burn three retries and a fallback on a play that was
    // never in doubt. It is still narrated — a silent gap would be worse — but
    // it is deliberately not a decision, so it stays out of the Reasoning feed.
    if (legal.length === 1) {
      table.playCard(seat.seatIndex, legal[0], true)
      ctx.log('action', `${seat.name} plays ${cardCode(legal[0])} (forced — only legal card).`, seat.id)
      ctx.pushSnapshot()
      await ctx.beat(0.35)
      return
    }

    const player = ctx.configFor(seat.id)
    if (!player) throw new Error(`No model configured for seat ${seat.name}.`)

    const result = await ctx.ask<Card>({
      player,
      prompt: buildHeartsPlayPrompt(table.state, seat, legal, this.tricks, this.settings.hearts),
      parse: (text) => parseHeartsPlayReply(text, legal),
      // The first legal card is always playable, so the hand can always finish.
      fallback: legal[0]
    })
    if (ctx.isStopping) return

    if (result.fallbackReason) {
      ctx.log(
        'error',
        `${player.name} could not choose a card (${result.fallbackReason}) — ` +
          `playing ${cardCode(legal[0])}.`,
        player.id
      )
    }

    table.playCard(seat.seatIndex, result.action)
    ctx.recordDecision(player, `plays ${cardCode(result.action)}`, result)
    ctx.log('action', `${seat.name} plays ${cardCode(result.action)}.`, seat.id)
    ctx.pushSnapshot()
    await ctx.beat()
  }
}
