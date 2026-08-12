import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluate5, evaluateBest, HandCategory } from '../src/main/games/poker/handEval.ts'
import type { Card, Rank, Suit } from '../src/shared/cards.ts'

/** Parses "As Kd Qh Jc Ts" into cards. */
function hand(text: string): Card[] {
  const rankMap: Record<string, number> = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    T: 10, J: 11, Q: 12, K: 13, A: 14
  }
  return text.split(/\s+/).map((code) => ({
    rank: rankMap[code[0].toUpperCase()] as Rank,
    suit: code[1].toLowerCase() as Suit
  }))
}

test('recognises each hand category', () => {
  assert.equal(evaluate5(hand('As Ks Qs Js Ts')).category, HandCategory.StraightFlush)
  assert.equal(evaluate5(hand('As Ks Qs Js Ts')).label, 'Royal flush')
  assert.equal(evaluate5(hand('9s 8s 7s 6s 5s')).category, HandCategory.StraightFlush)
  assert.equal(evaluate5(hand('7c 7d 7h 7s 2c')).category, HandCategory.Quads)
  assert.equal(evaluate5(hand('7c 7d 7h 2s 2c')).category, HandCategory.FullHouse)
  assert.equal(evaluate5(hand('As Js 9s 5s 2s')).category, HandCategory.Flush)
  assert.equal(evaluate5(hand('9c 8d 7h 6s 5c')).category, HandCategory.Straight)
  assert.equal(evaluate5(hand('7c 7d 7h 9s 2c')).category, HandCategory.Trips)
  assert.equal(evaluate5(hand('7c 7d 9h 9s 2c')).category, HandCategory.TwoPair)
  assert.equal(evaluate5(hand('7c 7d 9h 4s 2c')).category, HandCategory.Pair)
  assert.equal(evaluate5(hand('Ac Jd 9h 4s 2c')).category, HandCategory.HighCard)
})

test('the wheel is a five-high straight, not ace-high', () => {
  const wheel = evaluate5(hand('Ac 2d 3h 4s 5c'))
  assert.equal(wheel.category, HandCategory.Straight)
  assert.equal(wheel.label, 'Straight, 5 high')
  const sixHigh = evaluate5(hand('2c 3d 4h 5s 6c'))
  assert.ok(sixHigh.value > wheel.value, 'six-high straight beats the wheel')
})

test('steel wheel is a straight flush', () => {
  const r = evaluate5(hand('As 2s 3s 4s 5s'))
  assert.equal(r.category, HandCategory.StraightFlush)
  assert.equal(r.label, 'Straight flush, 5 high')
})

test('category ordering holds', () => {
  const ascending = [
    'Ac Jd 9h 4s 2c',   // high card
    '7c 7d 9h 4s 2c',   // pair
    '7c 7d 9h 9s 2c',   // two pair
    '7c 7d 7h 9s 2c',   // trips
    '9c 8d 7h 6s 5c',   // straight
    'As Js 9s 5s 2s',   // flush
    '7c 7d 7h 2s 2c',   // full house
    '7c 7d 7h 7s 2c',   // quads
    '9s 8s 7s 6s 5s'    // straight flush
  ].map((h) => evaluate5(hand(h)).value)

  for (let i = 1; i < ascending.length; i++) {
    assert.ok(ascending[i] > ascending[i - 1], `rank ${i} should beat rank ${i - 1}`)
  }
})

test('kickers break ties', () => {
  const better = evaluate5(hand('Kc Kd 9h 7s 2c'))
  const worse = evaluate5(hand('Kc Kd 9h 6s 2c'))
  assert.ok(better.value > worse.value)

  const aceHigh = evaluate5(hand('Ac Kd 9h 7s 2c'))
  const kingHigh = evaluate5(hand('Qc Kd 9h 7s 2c'))
  assert.ok(aceHigh.value > kingHigh.value)

  // Two pair compares top pair, then bottom pair, then the kicker.
  assert.ok(
    evaluate5(hand('Ac Ad 2h 2s Kc')).value > evaluate5(hand('Kc Kd Qh Qs Ac')).value
  )
  assert.ok(
    evaluate5(hand('Ac Ad 3h 3s 4c')).value > evaluate5(hand('Ac Ad 2h 2s Kc')).value
  )
})

test('identical hands of different suits tie exactly', () => {
  assert.equal(evaluate5(hand('Ac Kc 9d 7h 2s')).value, evaluate5(hand('Ad Kd 9c 7s 2h')).value)
})

test('picks the best five from seven', () => {
  // A pair is available, but five spades beat it.
  const r = evaluateBest(hand('As Ks 2c 2d 7s 9s 4s'))
  assert.equal(r.category, HandCategory.Flush)
  assert.equal(r.cards.length, 5)
  assert.ok(r.cards.every((c) => c.suit === 's'))
})

test('seven-card straight uses the highest run', () => {
  const r = evaluateBest(hand('5c 6d 7h 8s 9c Tc 2d'))
  assert.equal(r.category, HandCategory.Straight)
  assert.equal(r.label, 'Straight, 10 high')
})

test('full house beats a flush drawn from seven cards', () => {
  const boat = evaluateBest(hand('Ah Ad Ac Kh Kd 2s 7s'))
  assert.equal(boat.category, HandCategory.FullHouse)
  assert.equal(boat.label, 'Full house, aces full of kings')
})

test('quads with the best kicker from seven', () => {
  const r = evaluateBest(hand('9c 9d 9h 9s Ac 2d 3h'))
  assert.equal(r.category, HandCategory.Quads)
  assert.equal(r.cards[4].rank, 14)
})

/* --------------------------------------------------- labels name the kicker */

test('hands that differ only by kicker do not print the same label', () => {
  // The showdown that prompted this: board 6d Ks Qc Qs 5s. Both players make
  // queens and fives off the board, and only the fifth card separates them.
  const withAce = evaluateBest(hand('6d Ks Qc Qs 5s As 5d'))
  const withKing = evaluateBest(hand('6d Ks Qc Qs 5s 2c 5h'))

  assert.ok(withAce.value > withKing.value, 'the ace kicker wins')
  assert.notEqual(withAce.label, withKing.label, 'a decisive kicker must be visible in the label')
  assert.match(withAce.label, /ace kicker/)
  assert.match(withKing.label, /king kicker/)
})

test('every category names whatever decides it', () => {
  const cases: Array<[string, RegExp]> = [
    ['As Ah Ad Ac Kd', /four of a kind, aces, king kicker/i],
    ['As Ah Ad Kc Qd', /three of a kind, aces, king kicker/i],
    ['As Ah Kd Kc Qd', /two pair, aces and kings, queen kicker/i],
    ['As Ah Kd Qc Jd', /pair of aces, king kicker/i],
    ['As Ks 9s 8s 5s', /flush, a high \(A K 9 8 5\)/i],
    ['As Kh 9d 8c 5s', /high card, a high \(A K 9 8 5\)/i],
    // Fully determined by what is already printed.
    ['As Ah Ad Kc Kd', /full house, aces full of kings/i],
    ['9s 8h 7d 6c 5s', /straight, 9 high/i]
  ]
  for (const [text, pattern] of cases) {
    assert.match(evaluate5(hand(text)).label, pattern)
  }
})

test('two pair with an identical kicker still reads as a tie', () => {
  const a = evaluate5(hand('As Ah Kd Kc Qd'))
  const b = evaluate5(hand('Ac Ad Kh Ks Qc'))
  assert.equal(a.value, b.value, 'genuinely equal hands stay equal')
  assert.equal(a.label, b.label, 'and still print the same')
})
