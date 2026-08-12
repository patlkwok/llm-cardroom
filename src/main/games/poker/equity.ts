import { freshDeck, type Card } from '../../../shared/cards.ts'
import { evaluateBest } from './handEval.ts'

/**
 * Win probability for each live hand, the way a televised table shows it.
 *
 * Pure and synchronous like the rest of the engine, and free — this is CPU,
 * not another paid API call.
 *
 * Equity depends only on the hole cards and the board, never on the betting, so
 * it needs recomputing just when the board changes or someone folds — roughly
 * four times a hand rather than once per decision.
 *
 * SPECTATOR ONLY. It is derived from every player's hole cards, so it must
 * never reach a prompt; that would leak opponents' cards and break the one
 * invariant the whole app rests on. A test guards this.
 */

export interface EquityOptions {
  /**
   * Cards that are out of play but not in the contest — folded players' hole
   * cards. They cannot come off the deck, so leaving them in would let runouts
   * deal cards that are provably unavailable.
   */
  dead?: Card[]
  /** Samples to draw when full enumeration would be too slow. */
  samples?: number
  /** Enumerate exhaustively while `runouts * hands` stays under this. */
  exhaustiveBudget?: number
  /** Injectable for deterministic tests; defaults to Math.random. */
  random?: () => number
}

/**
 * Sampling is budgeted in hand-evaluations rather than samples, so an
 * eight-handed table costs the same wall time as a heads-up one. A flat sample
 * count made the 8-way preflop case take ~2.9s, which stalls the main process
 * and with it every IPC message. This holds the worst case near half a second,
 * absorbed by the step delay the runner is about to wait out anyway.
 */
const DEFAULT_EVAL_BUDGET = 6000
const MIN_SAMPLES = 500
const MAX_SAMPLES = 3000
const DEFAULT_BUDGET = 400_000

/**
 * Returns each hand's share of the pot in the long run, ties split evenly.
 * Shares sum to 1. `hands` must be the live players only, in seat order.
 */
export function handEquity(
  hands: Card[][],
  board: Card[],
  options: EquityOptions = {}
): number[] {
  if (hands.length === 0) return []
  if (hands.length === 1) return [1]
  if (board.length > 5) throw new Error(`board has ${board.length} cards`)

  const seen = new Set<string>()
  for (const card of [...hands.flat(), ...board, ...(options.dead ?? [])]) {
    seen.add(`${card.rank}${card.suit}`)
  }
  const deck = freshDeck().filter((c) => !seen.has(`${c.rank}${c.suit}`))

  const need = 5 - board.length
  const wins = new Array<number>(hands.length).fill(0)
  let trials = 0

  const score = (runout: Card[]): void => {
    let best = -1
    let winners: number[] = []
    for (let i = 0; i < hands.length; i++) {
      const value = evaluateBest([...hands[i], ...board, ...runout]).value
      if (value > best) {
        best = value
        winners = [i]
      } else if (value === best) {
        winners.push(i)
      }
    }
    const share = 1 / winners.length
    for (const i of winners) wins[i] += share
    trials++
  }

  const budget = options.exhaustiveBudget ?? DEFAULT_BUDGET

  if (need === 0) {
    score([])
  } else if (countCombinations(deck.length, need) * hands.length <= budget) {
    // Exact: from the flop on, there are at most ~1,100 runouts.
    forEachCombination(deck, need, score)
  } else {
    // Preflop only. A few thousand samples put the error well under a point,
    // which is finer than the display resolution anyway.
    const random = options.random ?? Math.random
    const samples =
      options.samples ??
      Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, Math.round(DEFAULT_EVAL_BUDGET / hands.length)))
    const pool = deck.slice()
    const runout = new Array<Card>(need)
    for (let s = 0; s < samples; s++) {
      // Partial Fisher-Yates: draws `need` distinct cards without reshuffling.
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(random() * (pool.length - i))
        const swap = pool[i]
        pool[i] = pool[j]
        pool[j] = swap
        runout[i] = pool[i]
      }
      score(runout)
    }
  }

  return wins.map((w) => w / trials)
}

function countCombinations(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  let out = 1
  for (let i = 0; i < k; i++) out = (out * (n - i)) / (i + 1)
  return Math.round(out)
}

/** Visits every k-subset of `deck`. The array passed in is reused — do not keep it. */
function forEachCombination(deck: Card[], k: number, visit: (cards: Card[]) => void): void {
  if (k === 0) {
    visit([])
    return
  }
  const n = deck.length
  const index = Array.from({ length: k }, (_, i) => i)
  const pick = new Array<Card>(k)

  for (;;) {
    for (let i = 0; i < k; i++) pick[i] = deck[index[i]]
    visit(pick)

    let i = k - 1
    while (i >= 0 && index[i] === n - k + i) i--
    if (i < 0) return
    index[i]++
    for (let j = i + 1; j < k; j++) index[j] = index[j - 1] + 1
  }
}
