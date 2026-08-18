/**
 * The rules every trick-taking game at this table shares.
 *
 * Extracted when Spades was written rather than after it, deliberately. Hearts
 * had all of this inline; a second game copying it would have left two versions
 * of "who takes the trick" to drift apart, and a third would have inherited the
 * drift. What lives here is only what is genuinely common — the games' own
 * decisions (points, trumps, contracts, passing) stay in their own engines.
 */

import { freshDeck, sameCard, shuffle, type Card, type Suit } from '../../../shared/cards.ts'
import type { TrickPlay } from '../../../shared/types.ts'

/** By suit then rank, so a rendered hand and a prompt read the same way. */
export function sortHand(cards: Card[]): Card[] {
  const order: Record<Suit, number> = { c: 0, d: 1, s: 2, h: 3 }
  return [...cards].sort((a, b) => order[a.suit] - order[b.suit] || a.rank - b.rank)
}

/** Deals a shuffled deck out evenly, each hand sorted. */
export function dealHands(seatCount: number, cardsPerHand: number): Card[][] {
  const deck = shuffle(freshDeck())
  return Array.from({ length: seatCount }, (_, i) =>
    sortHand(deck.slice(i * cardsPerHand, (i + 1) * cardsPerHand))
  )
}

/**
 * The cards of the led suit. Empty means the seat is void and may play anything
 * its own game still permits.
 */
export function followSuit(hand: Card[], leadSuit: Suit): Card[] {
  return hand.filter((card) => card.suit === leadSuit)
}

/**
 * What a seat on lead may open with, when one suit is held back until it has
 * been "broken" — hearts at Hearts, spades at Spades. It is the same rule in
 * both, including the escape: a seat holding nothing else leads it anyway.
 */
export function leadableCards(hand: Card[], restricted: Suit, broken: boolean): Card[] {
  if (broken) return [...hand]
  const others = hand.filter((card) => card.suit !== restricted)
  return others.length > 0 ? others : [...hand]
}

/**
 * Who takes the trick: the highest trump if any was played, and otherwise the
 * highest card of the suit that was led.
 *
 * `trump` is undefined at Hearts, which has none — the trumpless case is not a
 * special case of the code, it is the same loop with nothing ranking above the
 * led suit.
 */
export function trickWinner<P extends TrickPlay>(plays: P[], leadSuit: Suit, trump?: Suit): P {
  if (plays.length === 0) throw new Error('an empty trick has no winner')
  const trumped = trump !== undefined && plays.some((play) => play.card.suit === trump)
  const suit = trumped ? trump : leadSuit

  let best = plays.find((play) => play.card.suit === suit)
  // Nobody followed and nothing trumped: only reachable if the led suit was
  // recorded wrongly, so fail loudly rather than awarding the trick to seat 0.
  if (!best) throw new Error(`no card of the led suit ${leadSuit} was played`)
  for (const play of plays) {
    if (play.card.suit === suit && play.card.rank > best.card.rank) best = play
  }
  return best
}

/** Removes one card from a hand, by value. Returns a new array. */
export function removeCard(hand: Card[], card: Card): Card[] {
  const at = hand.findIndex((held) => sameCard(held, card))
  if (at === -1) return [...hand]
  return [...hand.slice(0, at), ...hand.slice(at + 1)]
}
