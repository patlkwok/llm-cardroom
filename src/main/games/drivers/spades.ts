import { cardCode, type Card } from '../../../shared/cards.ts'
import { GAMES } from '../../../shared/types.ts'
import type { MatchSettings, SpadesState, SpadesTrick } from '../../../shared/types.ts'
import type { DriverContext, GameDriver } from '../driver.ts'
import {
  BLIND_NIL_VALUE,
  NIL_VALUE,
  SpadesTable,
  SPADES_SEATS,
  suggestedBid,
  TRICKS_PER_HAND
} from '../spades/engine.ts'
import {
  buildSpadesBidPrompt,
  buildSpadesBlindNilPrompt,
  buildSpadesPlayPrompt,
  parseSpadesBidReply,
  parseSpadesBlindNilReply,
  parseSpadesPlayReply
} from '../prompts/spades.ts'

/**
 * Partnership Spades: four models, two teams, thirteen tricks a hand.
 *
 * Fixed roster by design, and for a sharper reason than Hearts': partnerships
 * are positional, so a seat joining or leaving would renumber the table and
 * hand somebody a different partner halfway through a match. It never calls
 * `ctx.reconcileRoster`.
 */
export class SpadesDriver implements GameDriver {
  readonly kind = 'spades' as const
  private table!: SpadesTable
  /** Completed tricks of the hand in progress, for the prompt's history block. */
  private tricks: SpadesTrick[] = []

  constructor(
    private readonly ctx: DriverContext,
    private readonly settings: MatchSettings
  ) {}

  get state(): SpadesState {
    return this.table.state
  }

  get roundsPlayed(): number {
    return this.table.state.handsPlayed
  }

  start(): void {
    const roster = this.ctx.roster
    if (roster.length !== SPADES_SEATS) {
      throw new Error(
        `${GAMES.spades.label} needs exactly ${SPADES_SEATS} models; ${roster.length} are seated.`
      )
    }

    this.table = new SpadesTable(
      roster.map((p) => ({ id: p.id, name: p.name, modelId: p.modelId })),
      this.settings.spades
    )

    const teams = this.table.state.teams
      .map((team) => `${team.name} (${team.seatIndices.map((i) => roster[i].name).join(' & ')})`)
      .join(' vs ')
    this.ctx.log(
      'system',
      `Partnership Spades to ${this.settings.spades.targetScore}: ${teams}. ` +
        'Partners sit opposite each other and may not talk — a model has to read ' +
        "its partner's hand out of the bidding and the play."
    )
  }

  finish(): void {
    const table = this.table
    if (!table) return
    const standings = table.standings
      .map((t) => `${t.name} ${t.score} (${t.bags} bag${t.bags === 1 ? '' : 's'})`)
      .join(', ')
    this.ctx.log('result', `Final scores — ${standings}.`)
    if (table.isMatchOver && !table.isDeadHeat) {
      this.ctx.log('result', `${table.winnerName} wins.`)
    }
  }

  async playRound(): Promise<'played' | 'ended'> {
    const ctx = this.ctx
    const table = this.table
    if (table.isMatchOver && !table.isDeadHeat) return 'ended'

    table.startHand()
    this.tricks = []
    const dealer = table.state.players[table.state.dealerIndex]
    ctx.log(
      'deal',
      `Hand ${table.state.handNumber}: 13 cards each, ${dealer.name} deals. ` +
        `${table.state.players[table.state.leadSeatIndex].name} bids first and leads.`
    )
    ctx.pushSnapshot()
    await ctx.beat()

    await this.runBlindNilOffers()
    if (ctx.isStopping) return 'ended'
    await this.runBidding()
    if (ctx.isStopping) return 'ended'

    // 13 tricks of 4 plays is 52; the bound only stops a wedged engine spinning.
    let guard = 0
    while (!table.handComplete && !ctx.isStopping && guard++ < 200) {
      await ctx.gate()
      if (ctx.isStopping) break
      await this.playOneCard()

      if (table.trickComplete) {
        const trick = table.resolveTrick()
        this.tricks.push(trick)
        const winnerSeat =
          trick.winnerSeatIndex === undefined ? undefined : table.state.players[trick.winnerSeatIndex]
        const team = winnerSeat ? table.teamOf(winnerSeat.seatIndex) : undefined
        ctx.log(
          'result',
          `Trick ${trick.number} to ${trick.winnerName} for ${team?.name ?? '?'} ` +
            `(${trick.plays.map((p) => cardCode(p.card)).join(' ')}).`,
          winnerSeat?.id
        )

        // The result is its own step: all four cards stay on the felt with the
        // winner marked for a full beat, so the operator can read who took it.
        // A trick that breaks a live nil lingers, because that is the moment
        // the hand turns.
        const brokeNil = winnerSeat !== undefined && winnerSeat.bid === 0
        if (brokeNil && winnerSeat) {
          // What it costs depends on whether the partner is also on nil: a
          // broken half of a double nil carries no nil penalty at all, it just
          // takes the +400 off the table. Naming a flat 100 there would be a
          // straightforwardly false number on the felt.
          const partner = table.partnerOf(winnerSeat.seatIndex)
          const partnerOnNil = partner.bid === 0
          const bonusOf = (seat: { blindNil: boolean }): number =>
            seat.blindNil ? BLIND_NIL_VALUE : NIL_VALUE
          const label = winnerSeat.blindNil ? 'BLIND NIL' : 'NIL'
          ctx.log(
            'result',
            partnerOnNil
              ? `${winnerSeat.name}'s ${label} is broken — the double nil is off, so ` +
                `${team?.name} loses the ` +
                `${(bonusOf(winnerSeat) + bonusOf(partner)) * 2} rather than taking a penalty.`
              : `${winnerSeat.name}'s ${label} is broken — that trick costs ${team?.name} ` +
                `${bonusOf(winnerSeat)} points.`,
            winnerSeat.id
          )
        }
        ctx.pushSnapshot()
        await ctx.beat(brokeNil ? 1.6 : 1)

        // Only now are the cards swept up and the next trick led.
        if (table.awaitingNextTrick && !ctx.isStopping) {
          table.startNextTrick()
          ctx.pushSnapshot()
        }
      }
    }

    if (ctx.isStopping) return 'ended'

    for (const scored of table.scoreHand()) {
      const { team } = scored
      const names = team.seatIndices.map((i) => table.state.players[i].name).join(' & ')
      ctx.log(
        'result',
        `${team.name} (${names}) bid ${team.contract} and took ${team.tricksWon}: ` +
          (scored.made
            ? `made it, ${scored.contractPoints >= 0 ? '+' : ''}${scored.contractPoints}` +
              (scored.bagsGained > 0
                ? ` and ${scored.bagsGained} bag${scored.bagsGained === 1 ? '' : 's'}`
                : '')
            : `SET, ${scored.contractPoints}`) +
          '.'
      )
      // A double nil is one result, not two. Reporting it seat by seat would
      // print "+100" twice for something worth +400, and "−100" for something
      // that carries no nil penalty at all — the label has to name whatever
      // actually decided the number.
      if (scored.doubleNil) {
        const who = scored.nils.map((n) => n.name).join(' and ')
        const broke = scored.nils.filter((n) => !n.made)
        // Naming the seats twice when both of them broke read as a stutter —
        // "X and Y both bid nil and X and Y took a trick". Say which case it is
        // instead.
        const blame =
          broke.length === scored.nils.length
            ? 'both took tricks'
            : `${broke.map((n) => n.name).join(' and ')} took a trick`
        const kind = scored.nils.every((n) => n.blind)
          ? 'DOUBLE BLIND NIL'
          : scored.nils.some((n) => n.blind)
            ? 'DOUBLE NIL (one of them blind)'
            : 'DOUBLE NIL'
        ctx.log(
          'result',
          broke.length === 0
            ? `${kind}: ${who} both took nothing — +${scored.nilPoints}.`
            : `${who} both bid nil and ${blame} — no nil penalty, but the contract ` +
              'was 0 so every trick they took is a bag.'
        )
      } else {
        for (const nil of scored.nils) {
          // A blind nil is worth double, so the number has to come from the
          // bid rather than from a constant.
          const value = nil.blind ? BLIND_NIL_VALUE : NIL_VALUE
          const label = nil.blind ? 'blind nil' : 'nil'
          ctx.log(
            'result',
            nil.made
              ? `${nil.name} brought the ${label} home — +${value}.`
              : `${nil.name} failed the ${label} — −${value}.`,
            table.state.players[nil.seatIndex].id
          )
        }
      }
      if (scored.bagPenalty < 0) {
        ctx.log(
          'error',
          `${team.name} rolled through ten bags — ${scored.bagPenalty} points. ` +
            `${scored.bagsAfter} bag${scored.bagsAfter === 1 ? '' : 's'} carried forward.`
        )
      }
      ctx.log(
        'result',
        `${team.name}: ${scored.delta >= 0 ? '+' : ''}${scored.delta} this hand, ` +
          `${team.score} total, ${team.bags} bag${team.bags === 1 ? '' : 's'}.`
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

    // A dead heat past the target is not a win. Another hand settles it, which
    // is what a real table would do rather than declaring joint winners.
    if (table.isMatchOver && table.isDeadHeat) {
      ctx.log('system', 'Both partnerships are level past the target — one more hand decides it.')
      return 'played'
    }
    return table.isMatchOver ? 'ended' : 'played'
  }

  /**
   * The blind-nil round, when the rule is on and somebody is far enough behind.
   * Asked before the ordinary bidding and **without showing the seat its hand**
   * — that is the whole of what makes it blind.
   */
  private async runBlindNilOffers(): Promise<void> {
    const ctx = this.ctx
    const table = this.table
    if (!table.blindBidding) return

    ctx.log(
      'deal',
      'Blind nil is on offer: a nil declared before seeing a single card, for ' +
        `±${BLIND_NIL_VALUE}.`
    )
    ctx.pushSnapshot()
    await ctx.beat(0.6)

    for (;;) {
      const seat = table.pendingBlindSeat
      if (!seat || ctx.isStopping) break

      const player = ctx.configFor(seat.id)
      if (!player) {
        table.setBlindNil(seat.seatIndex, false)
        continue
      }

      const deficit = table.blindNilDeficit(seat.seatIndex)
      const result = await ctx.ask<boolean>({
        player,
        prompt: buildSpadesBlindNilPrompt(table.state, seat, deficit, this.settings.spades),
        parse: (text) => parseSpadesBlindNilReply(text),
        // Declining is the fallback, and not a close call: a blind nil is
        // ±200 taken sight unseen, so committing a model to one because it
        // failed to answer would be the worst default in the app. Same
        // principle as the ordinary bid never falling back to nil, with twice
        // the swing behind it.
        fallback: false
      })
      if (ctx.isStopping) return

      if (result.fallbackReason) {
        ctx.log(
          'error',
          `${player.name} could not answer the blind nil offer (${result.fallbackReason}) — ` +
            'declining on its behalf.',
          player.id
        )
      }

      table.setBlindNil(seat.seatIndex, result.action)
      ctx.recordDecision(
        player,
        result.action ? 'bids BLIND NIL' : 'declines blind nil',
        result
      )
      if (result.action) {
        ctx.log(
          'action',
          `${seat.name} bids BLIND NIL — ${deficit} points behind, and has not seen a card.`,
          player.id
        )
      }
      ctx.pushSnapshot()
      await ctx.beat(result.action ? 1 : 0.4)
    }

    const blind = table.state.players.filter((p) => p.blindNil)
    if (blind.length === 2 && blind[0].teamIndex === blind[1].teamIndex) {
      ctx.log(
        'result',
        `DOUBLE BLIND NIL — ${blind.map((p) => p.name).join(' and ')} have both committed ` +
          'sight unseen.'
      )
      ctx.pushSnapshot()
      await ctx.beat(1.2)
    }
  }

  /** Four bids, in turn, each one visible to everybody who bids after it. */
  private async runBidding(): Promise<void> {
    const ctx = this.ctx
    const table = this.table

    for (;;) {
      const seat = table.pendingBidSeat
      if (!seat || ctx.isStopping) break

      const player = ctx.configFor(seat.id)
      const fallback = suggestedBid(seat.hand)
      if (!player) {
        // No model behind the seat: bid what the cards are worth and move on.
        table.setBid(seat.seatIndex, fallback)
        continue
      }

      const result = await ctx.ask<number>({
        player,
        prompt: buildSpadesBidPrompt(table.state, seat, this.settings.spades),
        parse: (text) => parseSpadesBidReply(text),
        // Never nil by accident. A fallback nil would charge a −100 swing to a
        // seat that merely failed to answer, so `suggestedBid` clamps to 1.
        fallback
      })
      if (ctx.isStopping) return

      if (result.fallbackReason) {
        ctx.log(
          'error',
          `${player.name} could not bid (${result.fallbackReason}) — bidding ${fallback}.`,
          player.id
        )
      }

      const bid = result.action
      table.setBid(seat.seatIndex, bid)
      ctx.recordDecision(player, bid === 0 ? 'bids NIL' : `bids ${bid}`, result)
      ctx.log(
        'action',
        bid === 0
          ? `${seat.name} bids NIL — no tricks at all, for ±100.`
          : `${seat.name} bids ${bid}.`,
        player.id
      )
      ctx.pushSnapshot()
      await ctx.beat(0.5)
    }

    if (ctx.isStopping) return

    const contracts = table.state.teams
      .map((team) => `${team.name} ${team.contract}`)
      .join(', ')
    const total = table.state.teams.reduce((sum, team) => sum + team.contract, 0)
    ctx.log(
      'deal',
      `Contracts: ${contracts} — ${total} tricks bid of ${TRICKS_PER_HAND}` +
        (total > TRICKS_PER_HAND
          ? '. Overbid, so somebody is getting set.'
          : total < TRICKS_PER_HAND
            ? '. Underbid, so bags are coming.'
            : ' — exactly right.') +
        ` ${table.state.players[table.state.leadSeatIndex].name} leads.`
    )
    ctx.pushSnapshot()
    await ctx.beat(1.2)
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
    // never in doubt. Narrated, but deliberately not a decision, so it stays
    // out of the Reasoning feed.
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
      prompt: buildSpadesPlayPrompt(table.state, seat, legal, this.tricks, this.settings.spades),
      parse: (text) => parseSpadesPlayReply(text, legal),
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
