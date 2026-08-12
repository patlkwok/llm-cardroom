import { cardCode } from '../../../shared/cards.ts'
import { GAMES } from '../../../shared/types.ts'
import type { MatchSettings, PlayerConfig, TwentyFourState } from '../../../shared/types.ts'
import type { AgentResult } from '../agent.ts'
import type { DriverContext, GameDriver, RosterTable } from '../driver.ts'
import { puzzleValue, TwentyFourTable, type TwentyFourAnswer } from '../twentyfour/engine.ts'
import { buildTwentyFourPrompt, parseTwentyFourReply } from '../prompts/twentyfour.ts'
import { tokenBudget } from '../../openrouter.ts'

/**
 * Least thinking room a 24 answer gets, whatever the reasoning effort says.
 * Searching four numbers for 24 is an open problem, not a menu, and the models
 * that reason unprompted routinely spend a few thousand tokens on it before
 * writing a character.
 */
const TWENTYFOUR_TOKEN_FLOOR = 8000

/**
 * The 24 puzzle: everyone answers the same four cards at once.
 *
 * This is the only game here with no turns, and the concurrency is the whole
 * cost of it — the puzzle itself is trivial next to a trick engine. Four things
 * are easy to get wrong and are handled explicitly below: dispatch skew,
 * `Promise.allSettled` swallowing fatal errors, answers appearing all at once
 * instead of arriving, and what the race actually measures.
 */
export class TwentyFourDriver implements GameDriver {
  readonly kind = 'twentyfour' as const
  private table!: TwentyFourTable

  constructor(
    private readonly ctx: DriverContext,
    private readonly settings: MatchSettings
  ) {}

  get state(): TwentyFourState {
    return this.table.state
  }

  get roundsPlayed(): number {
    return this.table.state.roundsPlayed
  }

  start(): void {
    const limits = GAMES.twentyfour
    const roster = this.ctx.roster
    if (roster.length < limits.minPlayers) {
      throw new Error('Seat a model at the table before starting.')
    }
    if (roster.length > limits.maxPlayers) {
      throw new Error(`The 24 puzzle seats at most ${limits.maxPlayers} models.`)
    }

    this.table = new TwentyFourTable(
      roster.map((p) => ({ id: p.id, name: p.name, modelId: p.modelId })),
      this.settings.twentyfour
    )

    const target = this.settings.twentyfour.targetScore
    this.ctx.log(
      'system',
      `${roster.length} model${roster.length === 1 ? '' : 's'} race the same four cards to 24` +
        (target > 0 ? `, first to ${target} rounds won.` : '.') +
        ' Every seat answers every puzzle, so each one costs a call per seat.'
    )
  }

  finish(): void {
    const table = this.table
    if (!table) return
    const standings = [...table.state.players]
      .sort((a, b) => b.score - a.score)
      .map((p) => `${p.name} ${p.score} (${p.solved}/${p.roundsPlayed} solved)`)
      .join(', ')
    this.ctx.log('result', `Final: ${standings}.`)
    if (table.isMatchOver) {
      this.ctx.log('result', `${table.winnerName} wins the match.`)
    }
  }

  private rosterTable(): RosterTable {
    const table = this.table
    return {
      seats: () => table.state.players.map((p) => ({ id: p.id, name: p.name, chips: 0 })),
      capacity: GAMES.twentyfour.maxPlayers,
      buyIn: 0,
      add: (player) =>
        table.addPlayer({ id: player.id, name: player.name, modelId: player.modelId }),
      remove: (id) => table.removePlayer(id)
    }
  }

  async playRound(): Promise<'played' | 'ended'> {
    const ctx = this.ctx
    const table = this.table
    if (table.isMatchOver) return 'ended'

    ctx.reconcileRoster(this.rosterTable())
    if (table.state.players.length === 0) {
      ctx.log('result', 'Nobody is left at the table, so the game ends.')
      return 'ended'
    }

    table.startRound()
    const s = table.state
    ctx.log(
      'deal',
      `Puzzle ${s.roundNumber}: ${s.cards.map(cardCode).join(' ')} — ` +
        `make 24 from ${s.cards.map(puzzleValue).join(', ')}.`
    )
    ctx.pushSnapshot()
    await ctx.beat(0.4)
    if (ctx.isStopping) return 'ended'

    const answers = await this.collectAnswers()
    if (ctx.isStopping) return 'ended'

    table.settleRound(answers)
    this.reportRound()
    ctx.pushSnapshot()
    // A simultaneous round has no steps inside it to pace, so the delay governs
    // the gap between puzzles instead.
    await ctx.beat(1.5)

    return table.isMatchOver ? 'ended' : 'played'
  }

  /**
   * Fires every model at once and waits for all of them.
   *
   * Losers are never cancelled: their tokens are already being generated, and
   * "what each model answered and how long it took" is much better data than
   * "who was first".
   */
  private async collectAnswers(): Promise<TwentyFourAnswer[]> {
    const ctx = this.ctx
    const table = this.table

    // Build every prompt BEFORE dispatching. Any `await` inside the dispatch
    // loop would hand the earlier models a head start on the ones after them.
    const jobs: Array<{ player: PlayerConfig; prompt: ReturnType<typeof buildTwentyFourPrompt> }> = []
    for (const seat of table.state.players) {
      const player = ctx.configFor(seat.id)
      if (!player) continue
      jobs.push({
        player,
        prompt: buildTwentyFourPrompt(table.state, seat, this.settings.twentyfour)
      })
    }

    const answers: TwentyFourAnswer[] = []
    const settled = await Promise.allSettled(
      jobs.map(({ player, prompt }) =>
        ctx
          .ask<string | null>({
            player,
            prompt,
            parse: parseTwentyFourReply,
            // No answer at all is graded as a miss, not as a wrong answer.
            fallback: null,
            // The hardest question this app asks. Every other game offers a
            // choice between named actions; this one is an open search, and a
            // model that reasons will spend thousands of tokens on it before
            // writing anything. Starting tight guarantees a truncated reply,
            // and a truncated reply is billed in full while returning nothing.
            //
            // A floor, not an override: a seat set to high effort keeps its own
            // larger budget.
            maxTokens: Math.max(tokenBudget(player.reasoningEffort), TWENTYFOUR_TOKEN_FLOOR),
            // A throw here would be swallowed by allSettled; the scan below
            // rethrows once every answer is in. See the comment on the scan.
            failFast: false
          })
          .then((result) => {
            // Each answer lands in its own callback, pushing its own snapshot,
            // so the operator sees them arrive one by one rather than all at
            // once when the slowest model finally returns. JavaScript being
            // single-threaded, these serialise on their own — no lock needed.
            this.recordAnswer(player, result, answers)
            ctx.pushSnapshot()
            return result
          })
      )
    )

    // `failFast` works elsewhere because the awaits are sequential and a throw
    // propagates. Under allSettled nothing propagates at all, so a 401 would
    // quietly become every model falling back — precisely the failure the
    // account-errors-are-fatal rule exists to prevent. Scan and rethrow.
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled' && outcome.value.fatalReason) {
        throw new Error(outcome.value.fatalReason)
      }
      if (outcome.status === 'rejected') {
        throw outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason))
      }
    }

    return answers
  }

  private recordAnswer(
    player: PlayerConfig,
    result: AgentResult<string | null>,
    answers: TwentyFourAnswer[]
  ): void {
    const ctx = this.ctx

    // A fatal failure is about to end the match, and nothing was really
    // answered. Recording it would charge four fabricated decisions to the
    // stats and put them in the Reasoning feed — which is exactly what the
    // sequential games avoid by throwing out of `ask` before they get here.
    if (result.fatalReason) return

    if (result.fallbackReason) {
      ctx.log(
        'error',
        `${player.name} gave no usable answer (${result.fallbackReason}).`,
        player.id
      )
    }

    answers.push({
      playerId: player.id,
      expression: result.action,
      // The attempt that produced the answer, NOT the wall clock. `agent.ts`
      // backs off 429s, and firing N calls at once is exactly what provokes
      // them, so ranking on total latency would let rate limiting decide the
      // round for reasons that have nothing to do with the puzzle.
      elapsedMs: result.finalAttemptMs
    })
    ctx.recordDecision(player, result.action === null ? 'answers none' : `answers ${result.action}`, result)
  }

  /** Says what everybody answered, in the order the answers came in. */
  private reportRound(): void {
    const ctx = this.ctx
    const s = this.table.state

    for (const result of s.results) {
      const time = Number.isFinite(result.elapsedMs) ? ` in ${(result.elapsedMs / 1000).toFixed(1)}s` : ''
      if (result.verdict === 'correct') {
        ctx.log(
          'result',
          result.expression === null
            ? `${result.playerName} correctly says there is no solution${time}.`
            : `${result.playerName} answers ${result.expression} = 24${time}.${result.won ? ' First!' : ''}`,
          result.playerId
        )
      } else if (result.verdict === 'wrong') {
        ctx.log(
          'result',
          `${result.playerName} answers ${result.expression === null ? '"no solution"' : result.expression}` +
            ` — ${result.problem ?? 'not 24'}`,
          result.playerId
        )
      } else if (result.verdict === 'invalid') {
        ctx.log(
          'error',
          `${result.playerName} answers ${result.expression} — ${result.problem ?? 'unusable'}`,
          result.playerId
        )
      } else {
        ctx.log('error', `${result.playerName} did not answer.`, result.playerId)
      }
    }

    // The solver's own answer, so the operator can see whether a puzzle was
    // genuinely hard or genuinely impossible. Spectator-only — never a prompt.
    ctx.log(
      'system',
      s.solvable ? `One solution: ${s.solution} = 24.` : 'That deal had no solution at all.'
    )
    if (s.lastRoundSummary) ctx.log('result', s.lastRoundSummary)
  }
}
