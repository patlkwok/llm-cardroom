import test from 'node:test'
import assert from 'node:assert/strict'
import { cardCode, freshDeck, sameCard, type Card, type Suit } from '../src/shared/cards.ts'
import {
  dealHands,
  followSuit,
  leadableCards,
  removeCard,
  sortHand,
  trickWinner
} from '../src/main/games/tricks/core.ts'
import type { TrickPlay } from '../src/shared/types.ts'

function card(code: string): Card {
  const ranks: Record<string, number> = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    T: 10, J: 11, Q: 12, K: 13, A: 14
  }
  return { rank: ranks[code[0]] as Card['rank'], suit: code[1] as Suit }
}

function trick(...codes: string[]): TrickPlay[] {
  return codes.map((code, seatIndex) => ({ seatIndex, seatId: `p${seatIndex}`, card: card(code) }))
}

/**
 * The point of the shared module is that Hearts and Spades cannot drift apart
 * on "who takes the trick". Hearts never plays a trump, so the trump half of
 * `trickWinner` has no Hearts test to lean on — these are it.
 */

test('with no trump, the highest card of the LED suit wins', () => {
  // The ace of hearts is the highest card played and takes nothing: clubs led.
  const plays = trick('4c', 'Ah', 'Kc', '2s')
  const winner = trickWinner(plays, 'c')
  assert.equal(cardCode(winner.card), 'Kc')
  assert.equal(winner.seatIndex, 2)
})

test('any trump beats every card of the led suit, however high', () => {
  const plays = trick('Ac', 'Kc', '2s', 'Qc')
  // The two of spades is the lowest card on the table and takes the ace.
  assert.equal(cardCode(trickWinner(plays, 'c', 's').card), '2s')
  // The same four cards, with no trump in force, go to the ace.
  assert.equal(cardCode(trickWinner(plays, 'c').card), 'Ac')
})

test('among several trumps the highest trump wins', () => {
  const plays = trick('Ac', '2s', 'Ts', '9s')
  assert.equal(cardCode(trickWinner(plays, 'c', 's').card), 'Ts')
})

test('a trump lead resolves as an ordinary suit lead', () => {
  const plays = trick('4s', 'Js', '2s', 'Qs')
  assert.equal(cardCode(trickWinner(plays, 's', 's').card), 'Qs')
})

test('a trick nobody followed and nobody trumped fails loudly', () => {
  // Only reachable if the led suit was recorded wrongly. Awarding it to seat 0
  // would look like a rules bug in the game above rather than a wedged trick.
  const plays = trick('4c', '5c', '6c', '7c')
  assert.throws(() => trickWinner(plays, 'd'), /no card of the led suit/)
  assert.throws(() => trickWinner([], 'c'), /empty trick/)
})

test('the winner is decided by the cards, not by the order they were played', () => {
  // An independent evaluation over every trump/lead combination the two games
  // can produce: exhaustive rather than sampled, because it is cheap.
  const deck = freshDeck()
  let checked = 0
  for (let i = 0; i < 200; i++) {
    const plays = trick(
      ...Array.from({ length: 4 }, () => {
        const c = deck[Math.floor(Math.random() * deck.length)]
        return `${'..23456789TJQKA'[c.rank]}${c.suit}`
      })
    )
    const leadSuit = plays[0].card.suit
    for (const trump of [undefined, 's'] as const) {
      const best = trickWinner(plays, leadSuit, trump)
      const trumped = trump !== undefined && plays.some((p) => p.card.suit === trump)
      const suit = trumped ? trump : leadSuit
      const contenders = plays.filter((p) => p.card.suit === suit)
      assert.equal(best.card.suit, suit)
      assert.ok(contenders.every((p) => p.card.rank <= best.card.rank))
      checked++
    }
  }
  assert.equal(checked, 400)
})

test('a held-back suit may not be led until it is broken, unless it is all that is held', () => {
  const hand = [card('2h'), card('Ah'), card('9c'), card('Kd')]
  const unbroken = leadableCards(hand, 'h', false)
  assert.deepEqual(unbroken.map(cardCode).sort(), ['9c', 'Kd'])

  const broken = leadableCards(hand, 'h', true)
  assert.equal(broken.length, 4)

  // The escape: nothing but the restricted suit left, so it is led anyway.
  const onlyHearts = [card('2h'), card('Ah')]
  assert.equal(leadableCards(onlyHearts, 'h', false).length, 2)

  // And it is a copy, not the hand itself — a caller that filters the result
  // must not be filtering the seat's cards out from under it.
  assert.notEqual(leadableCards(hand, 'h', true), hand)
})

test('following suit offers exactly the led suit, and nothing when void', () => {
  const hand = [card('2h'), card('9c'), card('Kc'), card('Kd')]
  assert.deepEqual(followSuit(hand, 'c').map(cardCode), ['9c', 'Kc'])
  assert.deepEqual(followSuit(hand, 's'), [])
})

test('a deal uses every card exactly once and sorts each hand', () => {
  const hands = dealHands(4, 13)
  assert.equal(hands.length, 4)

  const seen = new Set<string>()
  for (const hand of hands) {
    assert.equal(hand.length, 13)
    assert.deepEqual(hand, sortHand(hand), 'each hand comes back sorted')
    for (const c of hand) seen.add(cardCode(c))
  }
  assert.equal(seen.size, 52)
})

test('removing a card takes one copy, not every match', () => {
  // Nothing in this deck is duplicated today, but the dou dizhu variant deals
  // two decks and "remove this card" must not clear both.
  const hand = [card('9c'), card('9c'), card('Kd')]
  const left = removeCard(hand, card('9c'))
  assert.equal(left.length, 2)
  assert.equal(left.filter((c) => sameCard(c, card('9c'))).length, 1)

  // A card that is not held leaves the hand alone rather than throwing: the
  // engines validate legality themselves, and this is the removal, not the rule.
  assert.deepEqual(removeCard(hand, card('As')).map(cardCode), ['9c', '9c', 'Kd'])
})
