/** Card primitives shared by both games. Ranks are numeric: 2..14 (14 = Ace). */

export type Suit = 'c' | 'd' | 'h' | 's'
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14

export interface Card {
  rank: Rank
  suit: Suit
}

export const SUITS: Suit[] = ['c', 'd', 'h', 's']
export const RANKS: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]

const RANK_LABEL: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A'
}

const SUIT_LABEL: Record<Suit, string> = { c: '♣', d: '♦', h: '♥', s: '♠' }
const SUIT_NAME: Record<Suit, string> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' }

export function rankLabel(rank: Rank): string {
  return RANK_LABEL[rank]
}

export function suitSymbol(suit: Suit): string {
  return SUIT_LABEL[suit]
}

export function isRed(card: Card): boolean {
  return card.suit === 'd' || card.suit === 'h'
}

/** Compact notation used in prompts and logs, e.g. "As", "Td". */
export function cardCode(card: Card): string {
  const r = card.rank === 10 ? 'T' : RANK_LABEL[card.rank]
  return `${r}${card.suit}`
}

/** Human-readable form used in LLM prompts, e.g. "Ace of spades". */
export function cardName(card: Card): string {
  const names: Record<number, string> = {
    11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace'
  }
  const r = names[card.rank] ?? String(card.rank)
  return `${r} of ${SUIT_NAME[card.suit]}`
}

export function cardsToCodes(cards: Card[]): string {
  return cards.length ? cards.map(cardCode).join(' ') : '(none)'
}

export function freshDeck(): Card[] {
  const deck: Card[] = []
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit })
  return deck
}

/**
 * Fisher-Yates using crypto-grade randomness so shuffles are not predictable
 * from a seeded PRNG. `getRandomValues` exists in both Node 24 and Chromium.
 */
export function shuffle<T>(items: T[]): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function randomInt(maxExclusive: number): number {
  // Rejection sampling keeps the distribution uniform.
  const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive
  const buf = new Uint32Array(1)
  let value = 0
  do {
    globalThis.crypto.getRandomValues(buf)
    value = buf[0]
  } while (value >= limit)
  return value % maxExclusive
}

/** A multi-deck shoe that reshuffles once the cut card is reached. */
export class Shoe {
  private cards: Card[] = []
  private dealt = 0

  constructor(
    private readonly deckCount: number,
    private readonly penetration = 0.75
  ) {
    this.reshuffle()
  }

  reshuffle(): void {
    const cards: Card[] = []
    for (let i = 0; i < this.deckCount; i++) cards.push(...freshDeck())
    this.cards = shuffle(cards)
    this.dealt = 0
  }

  /** True when the cut card was passed and the shoe was rebuilt for this deal. */
  reshuffleIfNeeded(): boolean {
    if (this.dealt >= this.cards.length * this.penetration) {
      this.reshuffle()
      return true
    }
    return false
  }

  draw(): Card {
    if (this.dealt >= this.cards.length) this.reshuffle()
    return this.cards[this.dealt++]
  }

  get remaining(): number {
    return this.cards.length - this.dealt
  }
}
