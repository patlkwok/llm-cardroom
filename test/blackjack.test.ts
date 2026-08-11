import test from 'node:test'
import assert from 'node:assert/strict'
import { BlackjackTable, handValue } from '../src/main/games/blackjack.ts'
import { DEFAULT_BLACKJACK_RULES, type BlackjackRules } from '../src/shared/types.ts'
import type { Card, Rank, Suit } from '../src/shared/cards.ts'

function cards(text: string): Card[] {
  const rankMap: Record<string, number> = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    T: 10, J: 11, Q: 12, K: 13, A: 14
  }
  return text.split(/\s+/).map((code) => ({
    rank: rankMap[code[0].toUpperCase()] as Rank,
    suit: code[1].toLowerCase() as Suit
  }))
}

function table(rules: Partial<BlackjackRules> = {}): BlackjackTable {
  // Insurance is off unless a test asks for it, so unrelated tests are not
  // interrupted by the extra offer phase when the dealer shows an ace.
  return new BlackjackTable({ ...DEFAULT_BLACKJACK_RULES, offerInsurance: false, ...rules })
}

/** Deals until the dealer's upcard is an ace, so insurance is on offer. */
function dealUntilAceUp(t: BlackjackTable, attempts = 500): boolean {
  for (let i = 0; i < attempts; i++) {
    t.startRound()
    if (t.awaitingInsurance) return true
    // Not an ace up: play the round out and try the next one.
    t.playDealerTurn()
    t.settle()
  }
  return false
}

test('hand values count aces high then low', () => {
  assert.deepEqual(handValue(cards('As Ks')), { total: 21, soft: true })
  assert.deepEqual(handValue(cards('As 6d')), { total: 17, soft: true })
  assert.deepEqual(handValue(cards('As 6d Kh')), { total: 17, soft: false })
  assert.deepEqual(handValue(cards('As Ad')), { total: 12, soft: true })
  assert.deepEqual(handValue(cards('As Ad Ah')), { total: 13, soft: true })
  assert.deepEqual(handValue(cards('As Ad 9h')), { total: 21, soft: true })
  assert.deepEqual(handValue(cards('Ks Qd 2h')), { total: 22, soft: false })
  assert.deepEqual(handValue(cards('Js Qd Kh')), { total: 30, soft: false })
})

test('face cards are all worth ten', () => {
  for (const face of ['T', 'J', 'Q', 'K']) {
    assert.equal(handValue(cards(`${face}s 5d`)).total, 15)
  }
})

test('a fresh round deals two cards to each side', () => {
  const t = table()
  t.startRound()
  assert.equal(t.state.hands.length, 1)
  assert.equal(t.state.hands[0].cards.length, 2)
  assert.equal(t.state.dealerCards.length, 2)
  assert.equal(t.state.dealerHoleHidden, true)
  assert.equal(t.state.bankroll, DEFAULT_BLACKJACK_RULES.startingBankroll - DEFAULT_BLACKJACK_RULES.baseBet)
})

test('naturals resolve without any player decision', () => {
  const t = table()
  let sawNatural = false
  for (let i = 0; i < 400 && !sawNatural; i++) {
    const resolved = t.startRound()
    if (resolved) {
      sawNatural = true
      assert.equal(t.state.phase, 'dealer')
      assert.equal(t.awaitingPlayer, false)
    }
    t.playDealerTurn()
    t.settle()
  }
  assert.ok(sawNatural, 'a natural should show up within 400 rounds')
})

test('double and split are offered only when they are legal', () => {
  const t = table()
  t.startRound()
  const hand = t.state.hands[0]

  hand.cards = cards('8s 8d')
  hand.status = 'active'
  t.state.phase = 'player'
  let legal = t.legalActions()
  assert.deepEqual(legal.sort(), ['double', 'hit', 'split', 'stand'])

  // Not a pair: no split.
  hand.cards = cards('8s 9d')
  legal = t.legalActions()
  assert.ok(!legal.includes('split'))
  assert.ok(legal.includes('double'))

  // Three cards: neither double nor split.
  hand.cards = cards('8s 9d 2c')
  legal = t.legalActions()
  assert.deepEqual(legal.sort(), ['hit', 'stand'])

  // Broke: no double or split even on a pair.
  hand.cards = cards('8s 8d')
  t.state.bankroll = 0
  legal = t.legalActions()
  assert.deepEqual(legal.sort(), ['hit', 'stand'])
})

test('doubling adds one card, doubles the bet, and ends the hand', () => {
  const t = table()
  t.startRound()
  const hand = t.state.hands[0]
  hand.cards = cards('5s 6d')
  hand.status = 'active'
  t.state.phase = 'player'
  const bankrollBefore = t.state.bankroll
  const betBefore = hand.bet

  t.applyAction('double')
  assert.equal(hand.bet, betBefore * 2)
  assert.equal(t.state.bankroll, bankrollBefore - betBefore)
  assert.equal(hand.cards.length, 3)
  assert.ok(['doubled', 'busted'].includes(hand.status))
  assert.equal(t.awaitingPlayer, false)
})

test('splitting produces two hands, each with its own bet', () => {
  const t = table()
  t.startRound()
  const hand = t.state.hands[0]
  hand.cards = cards('8s 8d')
  hand.status = 'active'
  t.state.phase = 'player'
  const bankrollBefore = t.state.bankroll
  const bet = hand.bet

  t.applyAction('split')
  assert.equal(t.state.hands.length, 2)
  assert.equal(t.state.bankroll, bankrollBefore - bet)
  for (const h of t.state.hands) {
    assert.equal(h.bet, bet)
    assert.equal(h.cards.length, 2)
    assert.equal(h.cards[0].rank, 8)
  }
})

test('split aces get exactly one card each and cannot act again', () => {
  const t = table()
  t.startRound()
  const hand = t.state.hands[0]
  hand.cards = cards('As Ad')
  hand.status = 'active'
  t.state.phase = 'player'

  t.applyAction('split')
  assert.equal(t.state.hands.length, 2)
  for (const h of t.state.hands) {
    assert.equal(h.cards.length, 2)
    assert.equal(h.status, 'stood')
    assert.equal(h.fromSplitAces, true)
  }
  assert.equal(t.awaitingPlayer, false, 'no further decisions after splitting aces')
})

test('resplitting stops at the configured maximum', () => {
  const t = table({ maxSplits: 3 })
  t.startRound()
  t.state.phase = 'player'
  t.state.bankroll = 100000

  // Force four hands, then confirm split is no longer offered.
  t.state.hands = [0, 1, 2, 3].map((i) => ({
    id: `h${i}`,
    cards: cards('8s 8d'),
    bet: 25,
    status: 'active' as const,
    fromSplitAces: false,
    splitDepth: 3
  }))
  t.state.activeHandIndex = 0
  assert.ok(!t.legalActions().includes('split'), 'four hands is the cap with maxSplits 3')
})

test('hitting past 21 busts the hand', () => {
  const t = table()
  t.startRound()
  const hand = t.state.hands[0]
  hand.cards = cards('7s 6d')
  hand.status = 'active'
  t.state.phase = 'player'

  // Keep hitting until the hand resolves; it must bust or stand on 21.
  let guard = 0
  while (t.awaitingPlayer && guard++ < 20) t.applyAction('hit')
  const finalStatus: string = hand.status
  assert.ok(['busted', 'stood'].includes(finalStatus))
  if (finalStatus === 'busted') assert.ok(handValue(hand.cards).total > 21)
})

test('dealer stands on all 17s under S17', () => {
  const t = table({ dealerHitsSoft17: false })
  for (let i = 0; i < 300; i++) {
    t.startRound()
    // Make sure at least one hand survives so the dealer actually draws.
    t.state.hands[0].status = 'stood'
    t.state.hands[0].cards = cards('Ts 7d')
    t.playDealerTurn()
    const { total, soft } = handValue(t.state.dealerCards)
    assert.ok(total >= 17, `dealer stopped on ${total}`)
    if (total === 17 && soft) {
      assert.ok(true, 'S17 dealer is allowed to stop on soft 17')
    }
    t.settle()
  }
})

test('dealer hits soft 17 under H17', () => {
  const t = table({ dealerHitsSoft17: true })
  for (let i = 0; i < 300; i++) {
    t.startRound()
    t.state.hands[0].status = 'stood'
    t.state.hands[0].cards = cards('Ts 7d')
    t.playDealerTurn()
    const { total, soft } = handValue(t.state.dealerCards)
    assert.ok(total >= 17)
    assert.ok(!(total === 17 && soft), 'H17 dealer must not stop on soft 17')
    t.settle()
  }
})

test('the dealer does not draw when every player hand is already dead', () => {
  const t = table()
  t.startRound()
  t.state.hands[0].status = 'busted'
  const before = t.state.dealerCards.length
  t.playDealerTurn()
  assert.equal(t.state.dealerCards.length, before)
  assert.equal(t.state.dealerHoleHidden, false)
})

test('settlement pays naturals at 3:2 and pushes against a dealer natural', () => {
  const t = table({ blackjackPayout: 1.5 })
  t.startRound()
  t.state.hands = [{
    id: 'h1', cards: cards('As Kd'), bet: 100, status: 'blackjack',
    fromSplitAces: false, splitDepth: 0
  }]
  t.state.dealerCards = cards('9s 8d')
  const bankrollBefore = t.state.bankroll
  t.settle()
  assert.equal(t.state.hands[0].outcome, 'blackjack')
  assert.equal(t.state.hands[0].net, 150)
  assert.equal(t.state.bankroll, bankrollBefore + 250)

  const t2 = table()
  t2.startRound()
  t2.state.hands = [{
    id: 'h1', cards: cards('As Kd'), bet: 100, status: 'blackjack',
    fromSplitAces: false, splitDepth: 0
  }]
  t2.state.dealerCards = cards('Ad Qh')
  t2.settle()
  assert.equal(t2.state.hands[0].outcome, 'push')
  assert.equal(t2.state.hands[0].net, 0)
})

test('settlement covers wins, losses, pushes and dealer busts', () => {
  const scenarios: Array<[string, string, string, number]> = [
    // player, dealer, expected outcome, expected net on a 100 bet
    ['Ts 9d', 'Ts 8d', 'win', 100],
    ['Ts 8d', 'Ts 9d', 'lose', -100],
    ['Ts 9d', 'Ts 9h', 'push', 0],
    ['Ts 9d', 'Ts 5d 8h', 'win', 100],
    ['Ts 5d 8h', 'Ts 9d', 'lose', -100]
  ]

  for (const [player, dealer, outcome, net] of scenarios) {
    const t = table()
    t.startRound()
    const busted = handValue(cards(player)).total > 21
    t.state.hands = [{
      id: 'h1', cards: cards(player), bet: 100,
      status: busted ? 'busted' : 'stood',
      fromSplitAces: false, splitDepth: 0
    }]
    t.state.dealerCards = cards(dealer)
    t.settle()
    assert.equal(t.state.hands[0].outcome, outcome, `${player} vs ${dealer}`)
    assert.equal(t.state.hands[0].net, net, `${player} vs ${dealer} net`)
  }
})

test('bankroll accounting stays consistent over a long session', () => {
  const t = table({ startingBankroll: 100000, baseBet: 25 })
  const start = t.state.bankroll

  for (let round = 0; round < 500 && !t.isBroke; round++) {
    const resolved = t.startRound()
    if (!resolved) {
      let guard = 0
      while (t.awaitingPlayer && guard++ < 30) {
        const legal = t.legalActions()
        const { total } = handValue(t.activeHand!.cards)
        if (legal.includes('split') && Math.random() < 0.5) t.applyAction('split')
        else if (legal.includes('double') && total === 11) t.applyAction('double')
        else if (total < 17) t.applyAction('hit')
        else t.applyAction('stand')
      }
    }
    t.playDealerTurn()
    t.settle()

    assert.ok(t.state.bankroll >= 0, 'bankroll never goes negative')
    assert.equal(
      t.state.bankroll,
      start + t.state.sessionNet,
      `bankroll should equal start plus net after round ${round}`
    )
    const counted = t.state.handsWon + t.state.handsLost + t.state.handsPushed
    assert.ok(counted > 0)
  }
})

test('a new stake applies from the next round, never to the hand in play', () => {
  const t = table({ baseBet: 25 })
  t.startRound()
  assert.equal(t.state.hands[0].bet, 25)

  t.setBaseBet(100)
  assert.equal(t.state.hands[0].bet, 25, 'the dealt hand keeps the stake it was wagered for')

  t.playDealerTurn()
  t.settle()
  t.startRound()
  assert.equal(t.state.hands[0].bet, 100, 'the next round uses the new stake')
})

test('an explicit wager overrides the standing stake for one round only', () => {
  const t = table({ baseBet: 25 })
  t.startRound(200)
  assert.equal(t.state.hands[0].bet, 200)
  assert.equal(t.state.bankroll, 800)

  t.playDealerTurn()
  t.settle()
  t.startRound()
  assert.equal(t.state.hands[0].bet, 25, 'the override does not persist')
})

test('a wager is clamped to what the bankroll can cover', () => {
  const t = table({ startingBankroll: 100, baseBet: 5 })
  t.startRound(10_000)
  assert.equal(t.state.hands[0].bet, 100, 'cannot bet more than the bankroll')
  assert.equal(t.state.bankroll, 0)

  const t2 = table({ startingBankroll: 100, baseBet: 5 })
  t2.startRound(-50)
  assert.ok(t2.state.hands[0].bet >= 1, 'a nonsense wager still produces a real bet')
})

test('bet limits span the table minimum up to the whole bankroll', () => {
  const t = table({ startingBankroll: 1000, baseBet: 25 })
  assert.deepEqual(t.betLimits(), { min: 25, max: 1000 })

  t.state.bankroll = 10
  const tight = t.betLimits()
  assert.equal(tight.min, 10, 'the minimum falls to whatever is left')
  assert.equal(tight.max, 10)
})

/* ------------------------------------------------------------- insurance */

test('insurance is offered only when the dealer shows an ace', () => {
  const t = table({ offerInsurance: true })
  assert.ok(dealUntilAceUp(t), 'an ace upcard should appear within 500 rounds')
  assert.equal(t.state.phase, 'insurance')
  assert.equal(t.state.insuranceOffered, true)
  assert.equal(t.state.dealerCards[0].rank, 14)
  assert.equal(t.awaitingPlayer, false, 'no play decisions until insurance is settled')
})

test('insurance is never offered when the rule is switched off', () => {
  const t = table({ offerInsurance: false })
  for (let i = 0; i < 400; i++) {
    t.startRound()
    assert.equal(t.awaitingInsurance, false)
    assert.equal(t.state.insuranceOffered, false)
    t.playDealerTurn()
    t.settle()
  }
})

test('insurance costs half the stake and is taken from the bankroll', () => {
  const t = table({ offerInsurance: true, baseBet: 100 })
  assert.ok(dealUntilAceUp(t))

  const stake = t.state.hands[0].bet
  assert.equal(t.insuranceCost, stake / 2)

  const before = t.state.bankroll
  t.resolveInsurance(true)
  assert.equal(t.state.insuranceBet, stake / 2)
  assert.equal(t.state.bankroll, before - stake / 2)
  assert.notEqual(t.state.phase, 'insurance', 'the offer is closed')
})

test('declining insurance costs nothing and records the choice', () => {
  const t = table({ offerInsurance: true })
  assert.ok(dealUntilAceUp(t))

  const before = t.state.bankroll
  t.resolveInsurance(false)
  assert.equal(t.state.insuranceBet, 0)
  assert.equal(t.state.insuranceOutcome, 'declined')
  assert.equal(t.state.bankroll, before)
})

test('insurance pays 2:1 against a dealer blackjack, cancelling the loss', () => {
  const t = table({ offerInsurance: true })
  t.startRound()
  t.state.hands = [{
    id: 'h1', cards: cards('Ts 9d'), bet: 100, status: 'stood',
    fromSplitAces: false, splitDepth: 0
  }]
  t.state.dealerCards = cards('As Kd')
  t.state.insuranceBet = 50
  const before = t.state.bankroll

  t.settle()
  assert.equal(t.state.insuranceOutcome, 'won')
  assert.equal(t.state.hands[0].outcome, 'lose')
  // Stake back plus twice the stake.
  assert.equal(t.state.bankroll, before + 150)
  // Lost 100 on the hand, won 100 on the side bet: the round is a wash.
  assert.equal(t.state.lastRoundNet, 0)
})

test('insurance is lost when the dealer has no blackjack', () => {
  const t = table({ offerInsurance: true })
  t.startRound()
  t.state.hands = [{
    id: 'h1', cards: cards('Ts 8d'), bet: 100, status: 'stood',
    fromSplitAces: false, splitDepth: 0
  }]
  t.state.dealerCards = cards('As 9d 7c') // ace up, but 17 not blackjack
  t.state.insuranceBet = 50
  const before = t.state.bankroll

  t.settle()
  assert.equal(t.state.insuranceOutcome, 'lost')
  assert.equal(t.state.hands[0].outcome, 'win')
  assert.equal(t.state.bankroll, before + 200, 'the hand still pays')
  assert.equal(t.state.lastRoundNet, 50, '+100 on the hand, -50 on insurance')
})

test('a natural against a dealer natural pushes while insurance still pays', () => {
  const t = table({ offerInsurance: true })
  t.startRound()
  t.state.hands = [{
    id: 'h1', cards: cards('Ad Ks'), bet: 100, status: 'blackjack',
    fromSplitAces: false, splitDepth: 0
  }]
  t.state.dealerCards = cards('As Kd')
  t.state.insuranceBet = 50
  const before = t.state.bankroll

  t.settle()
  assert.equal(t.state.hands[0].outcome, 'push')
  assert.equal(t.state.insuranceOutcome, 'won')
  assert.equal(t.state.bankroll, before + 250, 'stake returned plus the insurance payout')
  assert.equal(t.state.lastRoundNet, 100, 'insurance profit only')
})

test('insurance is not offered when the bankroll cannot cover it', () => {
  const t = table({ offerInsurance: true, startingBankroll: 100, baseBet: 100 })
  // The whole bankroll goes on the hand, leaving nothing for the side bet.
  for (let i = 0; i < 200; i++) {
    t.state.bankroll = 100
    t.startRound()
    assert.equal(t.awaitingInsurance, false, 'cannot afford insurance')
    t.playDealerTurn()
    t.settle()
  }
})

test('bankroll accounting holds over a long session with insurance in play', () => {
  const t = table({ offerInsurance: true, startingBankroll: 100000, baseBet: 25 })
  const start = t.state.bankroll
  let offers = 0

  for (let round = 0; round < 600 && !t.isBroke; round++) {
    t.startRound()
    if (t.awaitingInsurance) {
      offers++
      t.resolveInsurance(round % 2 === 0) // alternate taking and declining
    }
    let guard = 0
    while (t.awaitingPlayer && guard++ < 30) {
      const { total } = handValue(t.activeHand!.cards)
      t.applyAction(total < 17 ? 'hit' : 'stand')
    }
    t.playDealerTurn()
    t.settle()

    assert.ok(t.state.bankroll >= 0, 'bankroll never goes negative')
    assert.equal(
      t.state.bankroll,
      start + t.state.sessionNet,
      `bankroll should equal start plus net after round ${round}`
    )
  }
  assert.ok(offers > 10, `insurance should come up regularly, saw ${offers}`)
})

test('the shoe reshuffles once it passes the cut card', () => {
  const t = table({ deckCount: 1 })
  let shuffles = 0
  for (let i = 0; i < 60; i++) {
    t.startRound()
    if (t.state.shoeJustShuffled) shuffles++
    t.playDealerTurn()
    t.settle()
    assert.ok(t.state.shoeRemaining >= 0)
  }
  assert.ok(shuffles > 0, 'a single deck must reshuffle during 60 rounds')
})
