import { rankLabel, type Card, type Rank } from '../../../shared/cards.ts'

export const HandCategory = {
  HighCard: 0,
  Pair: 1,
  TwoPair: 2,
  Trips: 3,
  Straight: 4,
  Flush: 5,
  FullHouse: 6,
  Quads: 7,
  StraightFlush: 8
} as const

export type HandCategory = (typeof HandCategory)[keyof typeof HandCategory]

export interface HandRank {
  /** Single comparable number; higher is better. */
  value: number
  category: HandCategory
  /** The five cards that make the hand, best first. */
  cards: Card[]
  label: string
}

const CATEGORY_NAME: Record<number, string> = {
  0: 'High card',
  1: 'Pair',
  2: 'Two pair',
  3: 'Three of a kind',
  4: 'Straight',
  5: 'Flush',
  6: 'Full house',
  7: 'Four of a kind',
  8: 'Straight flush'
}

const PLURAL: Record<number, string> = {
  2: 'twos', 3: 'threes', 4: 'fours', 5: 'fives', 6: 'sixes', 7: 'sevens',
  8: 'eights', 9: 'nines', 10: 'tens', 11: 'jacks', 12: 'queens', 13: 'kings', 14: 'aces'
}

const SINGULAR: Record<number, string> = {
  2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven',
  8: 'eight', 9: 'nine', 10: 'ten', 11: 'jack', 12: 'queen', 13: 'king', 14: 'ace'
}

function encode(category: HandCategory, tiebreakers: number[]): number {
  // Five slots of base 15 leave room for every rank 2..14.
  let value = category
  for (let i = 0; i < 5; i++) {
    value = value * 15 + (tiebreakers[i] ?? 0)
  }
  return value
}

/** Detects a straight in a descending list of distinct ranks. Returns its high card. */
function straightHigh(descendingDistinct: number[]): number | null {
  const ranks = descendingDistinct.slice()
  // The wheel: an ace plays low, below the five.
  if (ranks[0] === 14 && ranks.includes(5)) ranks.push(1)

  let run = 1
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] === ranks[i - 1] - 1) {
      run++
      if (run >= 5) return ranks[i] + 4
    } else if (ranks[i] !== ranks[i - 1]) {
      run = 1
    }
  }
  return null
}

/** Scores exactly five cards. */
export function evaluate5(cards: Card[]): HandRank {
  const sorted = cards.slice().sort((a, b) => b.rank - a.rank)
  const ranks = sorted.map((c) => c.rank)

  const counts = new Map<number, number>()
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1)

  // Group ranks by count first, then by rank; that ordering is exactly the
  // tiebreaker order for pairs, trips, quads and full houses.
  const grouped = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
  const shape = grouped.map(([, count]) => count)
  const byGroup = grouped.map(([rank]) => rank)

  const isFlush = sorted.every((c) => c.suit === sorted[0].suit)
  const distinctDesc = [...new Set(ranks)].sort((a, b) => b - a)
  const high = straightHigh(distinctDesc)
  const isStraight = high !== null

  const order = (): Card[] => {
    if (isStraight && high !== null) {
      // Order the run high-to-low; the wheel shows 5-4-3-2-A.
      const wanted = [high, high - 1, high - 2, high - 3, high - 4].map((r) => (r === 1 ? 14 : r))
      const out: Card[] = []
      for (const r of wanted) {
        const card = sorted.find((c) => c.rank === r && !out.includes(c))
        if (card) out.push(card)
      }
      return out
    }
    const out: Card[] = []
    for (const rank of byGroup) out.push(...sorted.filter((c) => c.rank === rank))
    return out
  }

  let category: HandCategory
  let tiebreakers: number[]

  if (isStraight && isFlush) {
    category = HandCategory.StraightFlush
    tiebreakers = [high as number]
  } else if (shape[0] === 4) {
    category = HandCategory.Quads
    tiebreakers = byGroup
  } else if (shape[0] === 3 && shape[1] === 2) {
    category = HandCategory.FullHouse
    tiebreakers = byGroup
  } else if (isFlush) {
    category = HandCategory.Flush
    tiebreakers = ranks
  } else if (isStraight) {
    category = HandCategory.Straight
    tiebreakers = [high as number]
  } else if (shape[0] === 3) {
    category = HandCategory.Trips
    tiebreakers = byGroup
  } else if (shape[0] === 2 && shape[1] === 2) {
    category = HandCategory.TwoPair
    tiebreakers = byGroup
  } else if (shape[0] === 2) {
    category = HandCategory.Pair
    tiebreakers = byGroup
  } else {
    category = HandCategory.HighCard
    tiebreakers = ranks
  }

  const best = order()
  return {
    value: encode(category, tiebreakers),
    category,
    cards: best,
    label: describe(category, byGroup, best, high)
  }
}

function describe(
  category: HandCategory,
  byGroup: number[],
  cards: Card[],
  high: number | null
): string {
  const name = CATEGORY_NAME[category]
  const r = (n: number): string => rankLabel(n as Rank)
  const p = (n: number): string => PLURAL[n]

  /**
   * Naming only the paired ranks made two hands that differ solely by kicker
   * print identically, so a correct showdown read as a mishandled tie. Anything
   * the label leaves out is a rank that can decide the pot.
   */
  const kicker = (rank: number | undefined): string =>
    rank === undefined ? '' : `, ${SINGULAR[rank]} kicker`

  /** Every rank in the hand, high to low — for the two categories where all five count. */
  const allRanks = (): string => cards.map((card) => r(card.rank)).join(' ')

  switch (category) {
    case HandCategory.StraightFlush:
      return high === 14 ? 'Royal flush' : `${name}, ${r(high as number)} high`
    case HandCategory.Quads:
      return `${name}, ${p(byGroup[0])}${kicker(byGroup[1])}`
    case HandCategory.FullHouse:
      // Trips plus pair fully determine a full house; nothing is left out.
      return `${name}, ${p(byGroup[0])} full of ${p(byGroup[1])}`
    case HandCategory.Flush:
      return `${name}, ${r(cards[0].rank)} high (${allRanks()})`
    case HandCategory.Straight:
      return `${name}, ${r(high as number)} high`
    case HandCategory.Trips:
      return `${name}, ${p(byGroup[0])}${kicker(byGroup[1])}`
    case HandCategory.TwoPair:
      return `${name}, ${p(byGroup[0])} and ${p(byGroup[1])}${kicker(byGroup[2])}`
    case HandCategory.Pair:
      return `${name} of ${p(byGroup[0])}${kicker(byGroup[1])}`
    default:
      return `${name}, ${r(cards[0].rank)} high (${allRanks()})`
  }
}

const COMBOS_5_OF_7: number[][] = (() => {
  const out: number[][] = []
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++)
      for (let c = b + 1; c < 7; c++)
        for (let d = c + 1; d < 7; d++)
          for (let e = d + 1; e < 7; e++) out.push([a, b, c, d, e])
  return out
})()

/** Best five-card hand from five, six or seven cards. */
export function evaluateBest(cards: Card[]): HandRank {
  if (cards.length < 5) throw new Error(`need at least 5 cards, got ${cards.length}`)
  if (cards.length === 5) return evaluate5(cards)

  let best: HandRank | null = null
  const combos =
    cards.length === 7
      ? COMBOS_5_OF_7
      : combinations(cards.length, 5)

  for (const idx of combos) {
    const hand = evaluate5(idx.map((i) => cards[i]))
    if (!best || hand.value > best.value) best = hand
  }
  return best as HandRank
}

function combinations(n: number, k: number): number[][] {
  const out: number[][] = []
  const pick: number[] = []
  const walk = (start: number): void => {
    if (pick.length === k) {
      out.push(pick.slice())
      return
    }
    for (let i = start; i < n; i++) {
      pick.push(i)
      walk(i + 1)
      pick.pop()
    }
  }
  walk(0)
  return out
}
