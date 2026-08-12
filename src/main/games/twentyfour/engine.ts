import { freshDeck, shuffle, type Card } from '../../../shared/cards.ts'
import type {
  TwentyFourPlayer,
  TwentyFourResult,
  TwentyFourRules,
  TwentyFourState
} from '../../../shared/types.ts'
import { equals, formatFrac, TARGET, validateExpression } from './expression.ts'
import { solve } from './solver.ts'

export const CARDS_PER_PUZZLE = 4

export interface TwentyFourSeed {
  id: string
  name: string
  modelId: string
}

/** One model's answer to one puzzle. */
export interface TwentyFourAnswer {
  playerId: string
  /** The expression given, or null when the model claimed no solution. */
  expression: string | null
  /**
   * How long the model took, lower being faster. The engine treats this as an
   * opaque ordering key and **never reads a clock itself** — a race is
   * non-deterministic and no test could assert a winner otherwise, so tests
   * supply the order and the ties directly.
   */
  elapsedMs: number
}

/**
 * Card values for the puzzle: **A = 1, J = 11, Q = 12, K = 13**.
 *
 * The all-faces-are-10 variant exists; this is the choice, and it is stated in
 * the system prompt so a model is never solving a different puzzle from the one
 * on the felt.
 */
export function puzzleValue(card: Card): number {
  return card.rank === 14 ? 1 : card.rank
}

/**
 * Four cards, combined with + - * / and brackets to make 24.
 *
 * Deals are **not** filtered for solvability. Dealing unsolvable hands on
 * purpose and accepting "no solution" as an answer is the only version of this
 * game that catches a model bluffing an expression that does not evaluate,
 * which is most of what makes it an interesting test at all.
 */
export class TwentyFourTable {
  readonly state: TwentyFourState

  constructor(seeds: TwentyFourSeed[], private readonly rules: TwentyFourRules) {
    if (seeds.length === 0) throw new Error('the 24 puzzle needs at least one model')
    this.state = {
      kind: 'twentyfour',
      phase: 'idle',
      roundNumber: 0,
      roundsPlayed: 0,
      cards: [],
      solvable: false,
      solution: null,
      players: seeds.map((seed, index) => this.blankPlayer(seed, index)),
      results: []
    }
  }

  private blankPlayer(seed: TwentyFourSeed, index: number): TwentyFourPlayer {
    return {
      id: seed.id,
      name: seed.name,
      modelId: seed.modelId,
      seatIndex: index,
      score: 0,
      solved: 0,
      missed: 0,
      wrong: 0,
      invalid: 0,
      roundsPlayed: 0,
      latencies: []
    }
  }

  player(id: string): TwentyFourPlayer | undefined {
    return this.state.players.find((p) => p.id === id)
  }

  /** The four card values, as the puzzle reads them. */
  get values(): number[] {
    return this.state.cards.map(puzzleValue)
  }

  get isMatchOver(): boolean {
    const target = this.rules.targetScore
    return target > 0 && this.state.players.some((p) => p.score >= target)
  }

  /** Most rounds won; an exact tie names everyone level at the top. */
  get winnerName(): string {
    const best = Math.max(...this.state.players.map((p) => p.score))
    return this.state.players
      .filter((p) => p.score === best)
      .map((p) => p.name)
      .join(' and ')
  }

  /* --------------------------------------------------------------- roster */

  addPlayer(seed: TwentyFourSeed): void {
    const s = this.state
    if (s.players.some((p) => p.id === seed.id)) return
    s.players.push(this.blankPlayer(seed, s.players.length))
  }

  removePlayer(id: string): boolean {
    const s = this.state
    const index = s.players.findIndex((p) => p.id === id)
    if (index === -1) return false
    s.players.splice(index, 1)
    s.players.forEach((player, i) => {
      player.seatIndex = i
    })
    return true
  }

  /* ----------------------------------------------------------------- deal */

  /** Deals four fresh cards and works out whether they can be made into 24. */
  startRound(): void {
    const s = this.state
    s.roundNumber++
    s.phase = 'answering'
    s.results = []
    s.lastRoundSummary = undefined
    for (const player of s.players) player.lastResult = undefined

    s.cards = shuffle(freshDeck()).slice(0, CARDS_PER_PUZZLE)
    // Spectator-only, like poker equity: computed here so the operator can be
    // shown the answer afterwards and a "no solution" claim can be graded, but
    // it must never reach a prompt.
    s.solution = solve(this.values)
    s.solvable = s.solution !== null
  }

  /**
   * Grades every answer and awards the round.
   *
   * Pure: given the same answers it always produces the same result, including
   * the same winner, because ordering comes entirely from the supplied
   * `elapsedMs` and never from a clock read here.
   */
  settleRound(answers: TwentyFourAnswer[]): void {
    const s = this.state
    const values = this.values

    const graded: TwentyFourResult[] = []
    for (const player of s.players) {
      const answer = answers.find((a) => a.playerId === player.id)
      graded.push(
        answer
          ? this.grade(player, answer, values)
          : {
              playerId: player.id,
              playerName: player.name,
              expression: null,
              verdict: 'none',
              elapsedMs: Number.POSITIVE_INFINITY,
              rank: 0,
              won: false
            }
      )
    }

    // Fastest correct answer takes the round. Ties break on seat order, so the
    // outcome is reproducible rather than dependent on array ordering.
    const correct = graded
      .filter((r) => r.verdict === 'correct')
      .sort(
        (a, b) =>
          a.elapsedMs - b.elapsedMs ||
          (this.player(a.playerId)?.seatIndex ?? 0) - (this.player(b.playerId)?.seatIndex ?? 0)
      )
    correct.forEach((result, index) => {
      result.rank = index + 1
      result.won = index === 0
    })

    for (const result of graded) {
      const player = this.player(result.playerId)
      if (!player) continue
      player.roundsPlayed++
      player.lastResult = result
      if (Number.isFinite(result.elapsedMs)) player.latencies.push(result.elapsedMs)

      if (result.verdict === 'correct') {
        player.solved++
        if (result.won) player.score++
      } else if (result.verdict === 'invalid') {
        player.invalid++
        if (s.solvable) player.missed++
      } else if (result.verdict === 'wrong') {
        player.wrong++
        if (s.solvable) player.missed++
      } else if (s.solvable) {
        player.missed++
      }
    }

    // Report in finishing order, so the felt reads as a race.
    s.results = graded.sort((a, b) => a.elapsedMs - b.elapsedMs)
    s.roundsPlayed++
    s.phase = 'settled'

    const winner = correct[0]
    s.lastRoundSummary = winner
      ? `${winner.playerName} got there first in ${(winner.elapsedMs / 1000).toFixed(1)}s.`
      : s.solvable
        ? 'Nobody solved it.'
        : 'No solution existed, and nobody spotted it.'
    if (!winner && !s.solvable && graded.some((r) => r.verdict === 'correct')) {
      s.lastRoundSummary = 'No solution existed.'
    }

    if (this.isMatchOver) {
      s.phase = 'complete'
      s.winnerName = this.winnerName
    }
  }

  private grade(
    player: TwentyFourPlayer,
    answer: TwentyFourAnswer,
    values: number[]
  ): TwentyFourResult {
    const base = {
      playerId: player.id,
      playerName: player.name,
      expression: answer.expression,
      elapsedMs: answer.elapsedMs,
      rank: 0,
      won: false
    }

    // Claiming no solution is a legal answer, graded against the solver.
    if (answer.expression === null) {
      return this.state.solvable
        ? {
            ...base,
            verdict: 'wrong',
            problem: `There is a solution: ${this.state.solution} = 24.`
          }
        : { ...base, verdict: 'correct' }
    }

    const check = validateExpression(answer.expression, values)
    if (!check.ok || !check.value) {
      return { ...base, verdict: 'invalid', problem: check.problem }
    }
    if (!equals(check.value, TARGET)) {
      return {
        ...base,
        verdict: 'wrong',
        valueLabel: formatFrac(check.value),
        problem: `That comes to ${formatFrac(check.value)}, not 24.`
      }
    }
    return { ...base, verdict: 'correct', valueLabel: '24' }
  }
}

/** The middle value of a list, for reporting a model's typical answering time. */
export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}
