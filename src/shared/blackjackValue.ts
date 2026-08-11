import type { Card } from './cards.ts'

export interface HandValue {
  total: number
  /** True when an ace is still counted as 11. */
  soft: boolean
}

/** Best total <= 21 if possible, otherwise the hard total. */
export function handValue(cards: Card[]): HandValue {
  let total = 0
  let aces = 0
  for (const card of cards) {
    if (card.rank === 14) {
      aces++
      total += 11
    } else {
      total += Math.min(card.rank, 10)
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10
    aces--
  }
  return { total, soft: aces > 0 }
}

export function describeValue(cards: Card[]): string {
  const { total, soft } = handValue(cards)
  if (total > 21) return `${total} (bust)`
  return soft ? `soft ${total}` : String(total)
}
