import { cardCode } from '../../../shared/cards.ts'
import { GAMES } from '../../../shared/types.ts'
import type {
  BlackjackAction,
  BlackjackPlayer,
  BlackjackState,
  MatchSettings,
  PlayerConfig
} from '../../../shared/types.ts'
import { BlackjackTable, describeValue } from '../blackjack.ts'
import type { DriverContext, GameDriver, RosterTable } from '../driver.ts'
import {
  buildBlackjackBetPrompt,
  buildBlackjackInsurancePrompt,
  buildBlackjackPrompt,
  parseBlackjackBetReply,
  parseBlackjackInsuranceReply,
  parseBlackjackReply
} from '../prompts/blackjack.ts'

/**
 * Several models against one dealer on one shoe. The shared shoe is the point:
 * seats face the same upcards in the same rounds, so comparing them is a paired
 * measurement rather than several unrelated sessions.
 */
export class BlackjackDriver implements GameDriver {
  readonly kind = 'blackjack' as const
  private table!: BlackjackTable

  constructor(
    private readonly ctx: DriverContext,
    private readonly settings: MatchSettings
  ) {}

  get state(): BlackjackState {
    return this.table.state
  }

  get roundsPlayed(): number {
    return this.table.state.roundsPlayed
  }

  start(): void {
    const limits = GAMES.blackjack
    const roster = this.ctx.roster
    if (roster.length < limits.minPlayers) {
      throw new Error('Add a model to the table before starting.')
    }
    if (roster.length > limits.maxPlayers) {
      throw new Error(`Blackjack seats at most ${limits.maxPlayers} models.`)
    }

    const rules = this.settings.blackjack
    this.table = new BlackjackTable(
      rules,
      roster.map((p) => ({ id: p.id, name: p.name, modelId: p.modelId }))
    )

    this.ctx.log(
      'system',
      roster.length === 1
        ? `${roster[0].name} sits down with ${rules.startingBankroll} chips, betting ${rules.baseBet} a hand.`
        : `${roster.length} models sit down with ${rules.startingBankroll} chips each, ` +
          `betting ${rules.baseBet} a hand and sharing one ${rules.deckCount}-deck shoe.`
    )
  }

  finish(): void {
    // Blackjack has no table winner: every seat plays the house on its own.
  }

  private rosterTable(): RosterTable {
    const table = this.table
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

  async playRound(): Promise<'played' | 'ended'> {
    const ctx = this.ctx
    const table = this.table

    // Seats join or leave here, at the boundary between rounds.
    ctx.reconcileRoster(this.rosterTable())
    if (table.state.players.length === 0) {
      ctx.log('result', 'Nobody is left at the table, so the game ends.')
      return 'ended'
    }

    // Picked up here so a stake change lands on the next deal, never mid-hand.
    table.setBaseBet(ctx.live.blackjackBaseBet)
    // The engine reports the transition, so a seat that went broke in round 7
    // is not re-announced in every round after it.
    for (const retired of table.retireBrokePlayers()) {
      ctx.log(
        'result',
        `${retired.name} is out of chips after ${retired.roundsPlayed} rounds.`,
        retired.id
      )
    }
    if (table.isTableBroke) {
      // The line above already named the only seat, so this would just repeat
      // it back at a one-seat table.
      if (table.state.players.length > 1) {
        ctx.log('result', `Nobody can cover the stake after ${table.state.roundsPlayed} rounds.`)
      }
      return 'ended'
    }

    const wagers = await this.collectWagers()
    if (ctx.isStopping) return 'ended'

    const resolvedOnDeal = table.startRound(wagers)
    if (table.state.shoeJustShuffled) ctx.log('system', 'The shoe is reshuffled.')

    ctx.log(
      'deal',
      `Round ${table.state.roundNumber}: dealer shows ${cardCode(table.state.dealerCards[0])}.`
    )
    for (const seat of table.activePlayers) {
      const hand = seat.hands[0]
      if (!hand) continue
      ctx.log(
        'deal',
        `${seat.name} bets ${hand.bet} and is dealt ${hand.cards.map(cardCode).join(' ')} ` +
          `(${describeValue(hand.cards)}).`,
        seat.id
      )
    }
    ctx.pushSnapshot()
    await ctx.beat()

    let resolved = resolvedOnDeal
    if (table.awaitingInsurance && !ctx.isStopping) {
      resolved = await this.offerInsurance()
    }
    if (ctx.isStopping) return 'ended'

    for (const seat of table.activePlayers) {
      if (seat.hands[0]?.status === 'blackjack') {
        ctx.log('result', `${seat.name} has blackjack!`, seat.id)
      }
    }

    if (!resolved) {
      // Six seats, four split hands each and a long run of hits is still far
      // inside this bound; it exists only to stop a wedged engine spinning.
      let guard = 0
      while (table.awaitingPlayer && !ctx.isStopping && guard++ < 500) {
        await ctx.gate()
        if (ctx.isStopping) break
        await this.playTurn()
      }
    }

    if (ctx.isStopping) return 'ended'

    const drawn = table.playDealerTurn()
    const dealerCards = table.state.dealerCards.map(cardCode).join(' ')
    ctx.log(
      'deal',
      drawn.length
        ? `Dealer reveals and draws ${drawn.map(cardCode).join(' ')} — ${dealerCards} (${describeValue(table.state.dealerCards)}).`
        : `Dealer shows ${dealerCards} (${describeValue(table.state.dealerCards)}).`
    )
    ctx.pushSnapshot()
    await ctx.beat()

    table.settle()
    this.reportRound()
    ctx.pushSnapshot()
    await ctx.beat(1.4)
    return 'played'
  }

  /** Logs what every seat did with the round that just settled. */
  private reportRound(): void {
    const ctx = this.ctx
    for (const seat of this.table.state.players) {
      if (seat.insuranceBet > 0) {
        ctx.log(
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
        ctx.log(
          'result',
          `${seat.name} ${verdict} ${net === 0 ? '' : `${net > 0 ? '+' : ''}${net} `}` +
            `(${hand.cards.map(cardCode).join(' ')} = ${describeValue(hand.cards)}).`,
          seat.id
        )
      }
    }

    const dealt = this.table.state.players.filter((seat) => seat.hands.length > 0)
    if (dealt.length === 1) {
      const seat = dealt[0]
      ctx.log(
        'result',
        `Bankroll: ${seat.bankroll} chips (session ${seat.sessionNet >= 0 ? '+' : ''}${seat.sessionNet}).`,
        seat.id
      )
    } else if (dealt.length > 1) {
      ctx.log(
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
  private async offerInsurance(): Promise<boolean> {
    const ctx = this.ctx
    const table = this.table

    for (;;) {
      const seat = table.insuranceSeat
      if (!seat || ctx.isStopping) break
      const player = ctx.configFor(seat.id)
      if (!player) {
        table.takeInsurance(seat.id, false)
        continue
      }

      const cost = seat.insuranceOffer
      const result = await ctx.ask<boolean>({
        player,
        prompt: buildBlackjackInsurancePrompt(table.state, seat, cost, this.settings.blackjack),
        parse: parseBlackjackInsuranceReply,
        // Declining is the safe default: insurance is a losing bet on average.
        fallback: false
      })
      if (ctx.isStopping) return false

      if (result.fallbackReason) {
        ctx.log(
          'error',
          `${player.name} could not answer the insurance offer (${result.fallbackReason}) — declining.`,
          player.id
        )
      }

      const took = result.action
      ctx.recordDecision(player, took ? 'takes insurance' : 'declines insurance', result)
      ctx.log(
        'action',
        took
          ? `${player.name} takes insurance for ${cost} chips.`
          : `${player.name} declines insurance.`,
        player.id
      )
      table.takeInsurance(seat.id, took)
      ctx.pushSnapshot()
      await ctx.beat(0.5)
    }

    if (ctx.isStopping) return false
    const resolved = table.closeInsurance()
    ctx.pushSnapshot()
    await ctx.beat()
    return resolved
  }

  /** Sizes every seat's wager before the cards come out. */
  private async collectWagers(): Promise<Record<string, number>> {
    const wagers: Record<string, number> = {}
    if (!this.ctx.live.modelChoosesBet) return wagers

    for (const seat of this.table.activePlayers) {
      if (this.ctx.isStopping) break
      const player = this.ctx.configFor(seat.id)
      if (!player) continue
      wagers[seat.id] = await this.chooseWager(player, seat)
    }
    return wagers
  }

  /** Asks the model to size its own wager before the cards come out. */
  private async chooseWager(player: PlayerConfig, seat: BlackjackPlayer): Promise<number> {
    const ctx = this.ctx
    const limits = this.table.betLimits(seat)
    if (limits.min >= limits.max) return limits.min

    const result = await ctx.ask<number>({
      player,
      prompt: buildBlackjackBetPrompt(this.table.state, seat, limits, this.settings.blackjack),
      parse: (text) => parseBlackjackBetReply(text, limits),
      // The table minimum is the safe default: it keeps the session alive.
      fallback: limits.min
    })
    if (ctx.isStopping) return limits.min

    if (result.fallbackReason) {
      ctx.log(
        'error',
        `${player.name} could not size a bet (${result.fallbackReason}) — betting the minimum ${limits.min}.`,
        player.id
      )
    }
    ctx.recordDecision(player, `bets ${result.action}`, result)
    return result.action
  }

  private async playTurn(): Promise<void> {
    const ctx = this.ctx
    const table = this.table
    const seat = table.activePlayer
    if (!seat) return
    const player = ctx.configFor(seat.id)
    if (!player) throw new Error(`No model configured for seat ${seat.name}.`)

    const legal = table.legalActions()
    if (!legal.length) return

    const result = await ctx.ask<BlackjackAction>({
      player,
      prompt: buildBlackjackPrompt(table.state, seat, legal, this.settings.blackjack),
      parse: (text) => parseBlackjackReply(text, legal),
      // Standing is the safe default: it never busts and never costs extra chips.
      fallback: 'stand'
    })
    if (ctx.isStopping) return

    if (result.fallbackReason) {
      ctx.log('error', `${player.name} could not answer (${result.fallbackReason}) — standing by default.`, player.id)
    }

    const before = table.activeHand
    const label = table.applyAction(result.action)
    const after = before ? before.cards.map(cardCode).join(' ') : ''

    ctx.recordDecision(player, result.action, result)
    ctx.log(
      'action',
      `${player.name} ${label}` + (after ? ` — ${after} (${describeValue(before!.cards)})` : ''),
      player.id
    )
    if (before?.status === 'busted') ctx.log('result', `${player.name} busts.`, player.id)

    ctx.pushSnapshot()
    await ctx.beat()
  }
}
