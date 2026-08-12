import test from 'node:test'
import assert from 'node:assert/strict'
import { BlackjackTable, handValue, insuranceCost } from '../src/main/games/blackjack.ts'
import {
  DEFAULT_BLACKJACK_RULES,
  type BlackjackPlayer,
  type BlackjackRules
} from '../src/shared/types.ts'
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

function seats(count: number): Array<{ id: string; name: string; modelId: string }> {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    name: `Seat${i}`,
    modelId: 'test/model'
  }))
}

function table(rules: Partial<BlackjackRules> = {}, seatCount = 1): BlackjackTable {
  // Insurance is off unless a test asks for it, so unrelated tests are not
  // interrupted by the extra offer phase when the dealer shows an ace.
  return new BlackjackTable(
    { ...DEFAULT_BLACKJACK_RULES, offerInsurance: false, ...rules },
    seats(seatCount)
  )
}

/** The one seat at a single-player table, which most of these tests use. */
function only(t: BlackjackTable): BlackjackPlayer {
  return t.state.players[0]
}

/** Puts a specific hand in front of the acting seat, ready to act. */
function stage(t: BlackjackTable, text: string, seatIndex = 0): BlackjackPlayer {
  const player = t.state.players[seatIndex]
  player.hands[0].cards = cards(text)
  player.hands[0].status = 'active'
  player.activeHandIndex = 0
  t.state.phase = 'player'
  t.state.activePlayerIndex = seatIndex
  return player
}

/** Plays every seat out with a crude fixed strategy. */
function playOut(t: BlackjackTable, allowSplits = false): void {
  let guard = 0
  while (t.awaitingPlayer && guard++ < 500) {
    const legal = t.legalActions()
    const { total } = handValue(t.activeHand!.cards)
    if (allowSplits && legal.includes('split') && Math.random() < 0.5) t.applyAction('split')
    else if (legal.includes('double') && total === 11) t.applyAction('double')
    else if (total < 17) t.applyAction('hit')
    else t.applyAction('stand')
  }
}

/** Deals until the dealer's upcard is an ace, so insurance is on offer. */
function dealUntilAceUp(t: BlackjackTable, attempts = 500): boolean {
  for (let i = 0; i < attempts; i++) {
    t.startRound()
    if (t.awaitingInsurance) return true
    // Not an ace up: play the round out and try the next one.
    playOut(t)
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
  assert.equal(only(t).hands.length, 1)
  assert.equal(only(t).hands[0].cards.length, 2)
  assert.equal(t.state.dealerCards.length, 2)
  assert.equal(t.state.dealerHoleHidden, true)
  assert.equal(
    only(t).bankroll,
    DEFAULT_BLACKJACK_RULES.startingBankroll - DEFAULT_BLACKJACK_RULES.baseBet
  )
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
    playOut(t)
    t.playDealerTurn()
    t.settle()
  }
  assert.ok(sawNatural, 'a natural should show up within 400 rounds')
})

test('double and split are offered only when they are legal', () => {
  const t = table()
  t.startRound()

  const player = stage(t, '8s 8d')
  let legal = t.legalActions()
  assert.deepEqual(legal.sort(), ['double', 'hit', 'split', 'stand'])

  // Not a pair: no split.
  player.hands[0].cards = cards('8s 9d')
  legal = t.legalActions()
  assert.ok(!legal.includes('split'))
  assert.ok(legal.includes('double'))

  // Three cards: neither double nor split.
  player.hands[0].cards = cards('8s 9d 2c')
  legal = t.legalActions()
  assert.deepEqual(legal.sort(), ['hit', 'stand'])

  // Broke: no double or split even on a pair.
  player.hands[0].cards = cards('8s 8d')
  player.bankroll = 0
  legal = t.legalActions()
  assert.deepEqual(legal.sort(), ['hit', 'stand'])
})

test('doubling adds one card, doubles the bet, and ends the hand', () => {
  const t = table()
  t.startRound()
  const player = stage(t, '5s 6d')
  const hand = player.hands[0]
  const bankrollBefore = player.bankroll
  const betBefore = hand.bet

  t.applyAction('double')
  assert.equal(hand.bet, betBefore * 2)
  assert.equal(player.bankroll, bankrollBefore - betBefore)
  assert.equal(hand.cards.length, 3)
  assert.ok(['doubled', 'busted'].includes(hand.status))
  assert.equal(t.awaitingPlayer, false)
})

test('splitting produces two hands, each with its own bet', () => {
  const t = table()
  t.startRound()
  const player = stage(t, '8s 8d')
  const bankrollBefore = player.bankroll
  const bet = player.hands[0].bet

  t.applyAction('split')
  assert.equal(player.hands.length, 2)
  assert.equal(player.bankroll, bankrollBefore - bet)
  for (const h of player.hands) {
    assert.equal(h.bet, bet)
    assert.equal(h.cards.length, 2)
    assert.equal(h.cards[0].rank, 8)
  }
})

test('split aces get exactly one card each and cannot act again', () => {
  const t = table()
  t.startRound()
  const player = stage(t, 'As Ad')

  t.applyAction('split')
  assert.equal(player.hands.length, 2)
  for (const h of player.hands) {
    assert.equal(h.cards.length, 2)
    assert.equal(h.status, 'stood')
    assert.equal(h.fromSplitAces, true)
  }
  assert.equal(t.awaitingPlayer, false, 'no further decisions after splitting aces')
})

test('resplitting stops at the configured maximum', () => {
  const t = table({ maxSplits: 3 })
  t.startRound()
  const player = only(t)
  t.state.phase = 'player'
  t.state.activePlayerIndex = 0
  player.bankroll = 100000

  // Force four hands, then confirm split is no longer offered.
  player.hands = [0, 1, 2, 3].map((i) => ({
    id: `h${i}`,
    cards: cards('8s 8d'),
    bet: 25,
    status: 'active' as const,
    fromSplitAces: false,
    splitDepth: 3
  }))
  player.activeHandIndex = 0
  assert.ok(!t.legalActions().includes('split'), 'four hands is the cap with maxSplits 3')
})

test('hitting past 21 busts the hand', () => {
  const t = table()
  t.startRound()
  const hand = stage(t, '7s 6d').hands[0]

  // Keep hitting until the hand resolves; it must bust or stand on 21.
  let guard = 0
  while (t.awaitingPlayer && guard++ < 20) t.applyAction('hit')
  const finalStatus: string = hand.status
  assert.ok(['busted', 'stood'].includes(finalStatus))
  if (finalStatus === 'busted') assert.ok(handValue(hand.cards).total > 21)
})

test('dealer stands on all 17s under S17', () => {
  // A deep bankroll so no seat is retired part way through the sample.
  const t = table({ dealerHitsSoft17: false, startingBankroll: 100000 })
  for (let i = 0; i < 300; i++) {
    t.startRound()
    // Make sure at least one hand survives so the dealer actually draws.
    only(t).hands[0].status = 'stood'
    only(t).hands[0].cards = cards('Ts 7d')
    t.playDealerTurn()
    const { total } = handValue(t.state.dealerCards)
    assert.ok(total >= 17, `dealer stopped on ${total}`)
    t.settle()
  }
})

test('dealer hits soft 17 under H17', () => {
  const t = table({ dealerHitsSoft17: true, startingBankroll: 100000 })
  for (let i = 0; i < 300; i++) {
    t.startRound()
    only(t).hands[0].status = 'stood'
    only(t).hands[0].cards = cards('Ts 7d')
    t.playDealerTurn()
    const { total, soft } = handValue(t.state.dealerCards)
    assert.ok(total >= 17)
    assert.ok(!(total === 17 && soft), 'H17 dealer must not stop on soft 17')
    t.settle()
  }
})

test('the dealer does not draw when every player hand is already dead', () => {
  const t = table({}, 3)
  t.startRound()
  for (const player of t.state.players) player.hands[0].status = 'busted'
  const before = t.state.dealerCards.length
  t.playDealerTurn()
  assert.equal(t.state.dealerCards.length, before)
  assert.equal(t.state.dealerHoleHidden, false)
})

test('the dealer still draws when only one of several seats is alive', () => {
  const t = table({}, 3)
  t.startRound()
  t.state.players[0].hands[0].status = 'busted'
  t.state.players[1].hands[0].status = 'busted'
  t.state.players[2].hands[0].status = 'stood'
  t.state.players[2].hands[0].cards = cards('Ts 7d')
  t.state.dealerCards = cards('6s 5d')
  t.playDealerTurn()
  assert.ok(handValue(t.state.dealerCards).total >= 17, 'the live seat must be played against')
})

test('settlement pays naturals at 3:2 and pushes against a dealer natural', () => {
  const t = table({ blackjackPayout: 1.5 })
  t.startRound()
  only(t).hands = [{
    id: 'h1', cards: cards('As Kd'), bet: 100, status: 'blackjack',
    fromSplitAces: false, splitDepth: 0
  }]
  t.state.dealerCards = cards('9s 8d')
  const bankrollBefore = only(t).bankroll
  t.settle()
  assert.equal(only(t).hands[0].outcome, 'blackjack')
  assert.equal(only(t).hands[0].net, 150)
  assert.equal(only(t).bankroll, bankrollBefore + 250)

  const t2 = table()
  t2.startRound()
  only(t2).hands = [{
    id: 'h1', cards: cards('As Kd'), bet: 100, status: 'blackjack',
    fromSplitAces: false, splitDepth: 0
  }]
  t2.state.dealerCards = cards('Ad Qh')
  t2.settle()
  assert.equal(only(t2).hands[0].outcome, 'push')
  assert.equal(only(t2).hands[0].net, 0)
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
    only(t).hands = [{
      id: 'h1', cards: cards(player), bet: 100,
      status: busted ? 'busted' : 'stood',
      fromSplitAces: false, splitDepth: 0
    }]
    t.state.dealerCards = cards(dealer)
    t.settle()
    assert.equal(only(t).hands[0].outcome, outcome, `${player} vs ${dealer}`)
    assert.equal(only(t).hands[0].net, net, `${player} vs ${dealer} net`)
  }
})

test('bankroll accounting stays consistent over a long session', () => {
  const t = table({ startingBankroll: 100000, baseBet: 25 })
  const start = only(t).bankroll

  for (let round = 0; round < 500 && !t.isTableBroke; round++) {
    t.startRound()
    playOut(t, true)
    t.playDealerTurn()
    t.settle()

    assert.ok(only(t).bankroll >= 0, 'bankroll never goes negative')
    assert.equal(
      only(t).bankroll,
      start + only(t).sessionNet,
      `bankroll should equal start plus net after round ${round}`
    )
    const counted = only(t).handsWon + only(t).handsLost + only(t).handsPushed
    assert.ok(counted > 0)
  }
})

test('a new stake applies from the next round, never to the hand in play', () => {
  const t = table({ baseBet: 25 })
  t.startRound()
  assert.equal(only(t).hands[0].bet, 25)

  t.setBaseBet(100)
  assert.equal(only(t).hands[0].bet, 25, 'the dealt hand keeps the stake it was wagered for')

  playOut(t)
  t.playDealerTurn()
  t.settle()
  t.startRound()
  assert.equal(only(t).hands[0].bet, 100, 'the next round uses the new stake')
})

test('an explicit wager overrides the standing stake for one round only', () => {
  const t = table({ baseBet: 25 })
  t.startRound({ p0: 200 })
  assert.equal(only(t).hands[0].bet, 200)
  assert.equal(only(t).bankroll, 800)

  playOut(t)
  t.playDealerTurn()
  t.settle()
  t.startRound()
  assert.equal(only(t).hands[0].bet, 25, 'the override does not persist')
})

test('a wager is clamped to what the bankroll can cover', () => {
  const t = table({ startingBankroll: 100, baseBet: 5 })
  t.startRound({ p0: 10_000 })
  assert.equal(only(t).hands[0].bet, 100, 'cannot bet more than the bankroll')
  assert.equal(only(t).bankroll, 0)

  const t2 = table({ startingBankroll: 100, baseBet: 5 })
  t2.startRound({ p0: -50 })
  assert.ok(only(t2).hands[0].bet >= 1, 'a nonsense wager still produces a real bet')
})

test('each seat wagers for itself', () => {
  const t = table({ startingBankroll: 1000, baseBet: 25 }, 3)
  t.startRound({ p0: 50, p2: 200 })
  assert.equal(t.state.players[0].hands[0].bet, 50)
  assert.equal(t.state.players[1].hands[0].bet, 25, 'a seat with no wager takes the table minimum')
  assert.equal(t.state.players[2].hands[0].bet, 200)
  assert.equal(t.state.players[2].bankroll, 800)
})

test('bet limits span the table minimum up to the whole bankroll', () => {
  const t = table({ startingBankroll: 1000, baseBet: 25 })
  assert.deepEqual(t.betLimits(only(t)), { min: 25, max: 1000 })

  only(t).bankroll = 10
  const tight = t.betLimits(only(t))
  assert.equal(tight.min, 10, 'the minimum falls to whatever is left')
  assert.equal(tight.max, 10)
})

/* ------------------------------------------------------- several seats */

test('every seat is dealt from the one shoe', () => {
  const t = table({ deckCount: 8 }, 6)
  const start = t.state.shoeRemaining
  let seen = 0

  for (let round = 0; round < 10; round++) {
    t.startRound()
    assert.equal(t.state.shoeJustShuffled, false, 'this test must not span a reshuffle')
    playOut(t, true)
    t.playDealerTurn()
    t.settle()

    // Every card the shoe gave out is face up somewhere on the table.
    seen += t.state.dealerCards.length
    for (const player of t.state.players) {
      for (const hand of player.hands) seen += hand.cards.length
    }
    assert.equal(
      t.state.shoeRemaining,
      start - seen,
      `cards dealt must equal cards visible after round ${round + 1}`
    )
  }
})

test('seats act in order, each finishing all its hands before the next', () => {
  const t = table({ startingBankroll: 100000 }, 4)

  for (let round = 0; round < 60; round++) {
    t.startRound()
    const order: number[] = []
    let guard = 0
    while (t.awaitingPlayer && guard++ < 500) {
      order.push(t.state.activePlayerIndex)
      const legal = t.legalActions()
      const { total } = handValue(t.activeHand!.cards)
      if (legal.includes('split')) t.applyAction('split')
      else if (total < 17) t.applyAction('hit')
      else t.applyAction('stand')
    }
    for (let i = 1; i < order.length; i++) {
      assert.ok(
        order[i] >= order[i - 1],
        `seat ${order[i]} acted after seat ${order[i - 1]} in round ${round + 1}`
      )
    }
    t.playDealerTurn()
    t.settle()
  }
})

test('one dealer hand settles every seat, and each bankroll balances', () => {
  const t = table({ startingBankroll: 5000, baseBet: 25 }, 5)
  const start = new Map(t.state.players.map((p) => [p.id, p.bankroll]))

  for (let round = 0; round < 200 && !t.isTableBroke; round++) {
    t.retireBrokePlayers()
    if (t.isTableBroke) break
    t.startRound()
    const dealerCardsBefore = t.state.dealerCards.length
    playOut(t, true)
    t.playDealerTurn()
    assert.ok(t.state.dealerCards.length >= dealerCardsBefore, 'one dealer hand for the table')
    t.settle()

    for (const player of t.state.players) {
      assert.ok(player.bankroll >= 0, `${player.name} went negative`)
      assert.equal(
        player.bankroll,
        (start.get(player.id) as number) + player.sessionNet,
        `${player.name} should equal start plus net after round ${round + 1}`
      )
    }
  }
})

test('a seat that runs out of chips is retired exactly once', () => {
  const t = table({ startingBankroll: 100, baseBet: 100 }, 3)
  t.state.players[1].bankroll = 10

  const first = t.retireBrokePlayers()
  assert.deepEqual(first.map((p) => p.id), ['p1'], 'only the short seat is retired')
  assert.equal(t.retireBrokePlayers().length, 0, 'and it is not reported again')
  assert.equal(t.activePlayers.length, 2)

  t.startRound()
  assert.equal(t.state.players[1].hands.length, 0, 'a retired seat is not dealt in')
  assert.equal(t.state.players[0].hands.length, 1)
})

test('the table is only broke once nobody can cover the stake', () => {
  const t = table({ startingBankroll: 100, baseBet: 100 }, 2)
  t.state.players[0].bankroll = 0
  t.retireBrokePlayers()
  assert.equal(t.isTableBroke, false, 'one seat still has chips')

  t.state.players[1].bankroll = 0
  t.retireBrokePlayers()
  assert.equal(t.isTableBroke, true)
})

test('seats can join and leave between rounds, taking their chips with them', () => {
  const t = table({ startingBankroll: 1000 }, 2)
  t.startRound()
  playOut(t)
  t.playDealerTurn()
  t.settle()

  t.addPlayer({ id: 'late', name: 'Latecomer', modelId: 'test/model' }, 500)
  assert.equal(t.state.players.length, 3)
  assert.equal(t.player('late')?.bankroll, 500)
  assert.equal(t.player('late')?.hands.length, 0, 'not dealt in until the next round')

  t.startRound()
  assert.equal(t.player('late')?.hands[0].cards.length, 2, 'dealt in from the next round')

  playOut(t)
  t.playDealerTurn()
  t.settle()

  assert.equal(t.removePlayer('p0'), true)
  assert.equal(t.removePlayer('p0'), false, 'removing twice is a no-op')
  assert.equal(t.state.players.length, 2)
  // Seat indices stay dense so the view and the engine agree on the order.
  assert.deepEqual(t.state.players.map((p) => p.seatIndex), [0, 1])
})

test('the table refuses more seats than it has', () => {
  const t = table({}, 6)
  assert.throws(
    () => t.addPlayer({ id: 'x', name: 'Seventh', modelId: 'test/model' }, 500),
    /full at 6 seats/
  )
  assert.throws(() => table({}, 7), /seats at most 6/)
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
    playOut(t)
    t.playDealerTurn()
    t.settle()
  }
})

test('insurance costs half the stake and is taken from the bankroll', () => {
  const t = table({ offerInsurance: true, baseBet: 100 })
  assert.ok(dealUntilAceUp(t))

  const stake = only(t).hands[0].bet
  assert.equal(insuranceCost(only(t)), stake / 2)

  const before = only(t).bankroll
  t.takeInsurance('p0', true)
  t.closeInsurance()
  assert.equal(only(t).insuranceBet, stake / 2)
  assert.equal(only(t).bankroll, before - stake / 2)
  assert.notEqual(t.state.phase, 'insurance', 'the offer is closed')
})

test('declining insurance costs nothing and records the choice', () => {
  const t = table({ offerInsurance: true })
  assert.ok(dealUntilAceUp(t))

  const before = only(t).bankroll
  t.takeInsurance('p0', false)
  t.closeInsurance()
  assert.equal(only(t).insuranceBet, 0)
  assert.equal(only(t).insuranceOutcome, 'declined')
  assert.equal(only(t).bankroll, before)
})

test('every seat is offered insurance, one at a time', () => {
  const t = table({ offerInsurance: true, baseBet: 100, startingBankroll: 100000 }, 4)
  assert.ok(dealUntilAceUp(t))

  const offered: string[] = []
  for (let guard = 0; guard < 10; guard++) {
    const seat = t.insuranceSeat
    if (!seat) break
    offered.push(seat.id)
    // Alternate, so the round exercises both answers at once.
    t.takeInsurance(seat.id, offered.length % 2 === 1)
  }
  assert.deepEqual(offered, ['p0', 'p1', 'p2', 'p3'], 'each seat in turn')
  assert.equal(t.insuranceSeat, undefined)

  assert.equal(t.state.players[0].insuranceBet, 50)
  assert.equal(t.state.players[1].insuranceBet, 0)
  assert.equal(t.state.players[1].insuranceOutcome, 'declined')

  t.closeInsurance()
  assert.notEqual(t.state.phase, 'insurance')
})

test('a seat left unanswered when the offer closes has simply declined', () => {
  const t = table({ offerInsurance: true, startingBankroll: 100000 }, 3)
  assert.ok(dealUntilAceUp(t))
  t.takeInsurance('p0', true)
  t.closeInsurance()

  assert.equal(t.state.players[1].insuranceOutcome, 'declined')
  assert.equal(t.state.players[2].insuranceOutcome, 'declined')
  assert.equal(t.state.players[1].insuranceBet, 0)
})

test('insurance pays 2:1 against a dealer blackjack, cancelling the loss', () => {
  const t = table({ offerInsurance: true })
  t.startRound()
  only(t).hands = [{
    id: 'h1', cards: cards('Ts 9d'), bet: 100, status: 'stood',
    fromSplitAces: false, splitDepth: 0
  }]
  t.state.dealerCards = cards('As Kd')
  only(t).insuranceBet = 50
  const before = only(t).bankroll

  t.settle()
  assert.equal(only(t).insuranceOutcome, 'won')
  assert.equal(only(t).hands[0].outcome, 'lose')
  // Stake back plus twice the stake.
  assert.equal(only(t).bankroll, before + 150)
  // Lost 100 on the hand, won 100 on the side bet: the round is a wash.
  assert.equal(only(t).lastRoundNet, 0)
})

test('insurance is lost when the dealer has no blackjack', () => {
  const t = table({ offerInsurance: true })
  t.startRound()
  only(t).hands = [{
    id: 'h1', cards: cards('Ts 8d'), bet: 100, status: 'stood',
    fromSplitAces: false, splitDepth: 0
  }]
  t.state.dealerCards = cards('As 9d 7c') // ace up, but 17 not blackjack
  only(t).insuranceBet = 50
  const before = only(t).bankroll

  t.settle()
  assert.equal(only(t).insuranceOutcome, 'lost')
  assert.equal(only(t).hands[0].outcome, 'win')
  assert.equal(only(t).bankroll, before + 200, 'the hand still pays')
  assert.equal(only(t).lastRoundNet, 50, '+100 on the hand, -50 on insurance')
})

test('a natural against a dealer natural pushes while insurance still pays', () => {
  const t = table({ offerInsurance: true })
  t.startRound()
  only(t).hands = [{
    id: 'h1', cards: cards('Ad Ks'), bet: 100, status: 'blackjack',
    fromSplitAces: false, splitDepth: 0
  }]
  t.state.dealerCards = cards('As Kd')
  only(t).insuranceBet = 50
  const before = only(t).bankroll

  t.settle()
  assert.equal(only(t).hands[0].outcome, 'push')
  assert.equal(only(t).insuranceOutcome, 'won')
  assert.equal(only(t).bankroll, before + 250, 'stake returned plus the insurance payout')
  assert.equal(only(t).lastRoundNet, 100, 'insurance profit only')
})

test('insurance is not offered to a seat that cannot cover it', () => {
  const t = table({ offerInsurance: true, startingBankroll: 100, baseBet: 100 })
  // The whole bankroll goes on the hand, leaving nothing for the side bet.
  for (let i = 0; i < 200; i++) {
    only(t).bankroll = 100
    t.startRound()
    assert.equal(t.awaitingInsurance, false, 'cannot afford insurance')
    playOut(t)
    t.playDealerTurn()
    t.settle()
  }
})

test('a rich seat is offered insurance even when a poor one cannot pay', () => {
  const t = table({ offerInsurance: true, baseBet: 100, startingBankroll: 100 }, 2)

  let found = false
  for (let i = 0; i < 500 && !found; i++) {
    // The whole of seat 0's bankroll goes on the hand, leaving nothing for the
    // side bet; seat 1 can always pay.
    t.state.players[0].bankroll = 100
    t.state.players[1].bankroll = 100_000
    t.startRound()
    if (t.awaitingInsurance) {
      found = true
      const offered: string[] = []
      for (let guard = 0; guard < 5; guard++) {
        const seat = t.insuranceSeat
        if (!seat) break
        offered.push(seat.id)
        t.takeInsurance(seat.id, false)
      }
      assert.deepEqual(offered, ['p1'], 'only the seat that can pay is asked')
      t.closeInsurance()
    }
    playOut(t)
    t.playDealerTurn()
    t.settle()
  }
  assert.ok(found, 'an ace upcard should appear within 500 rounds')
})

test('bankroll accounting holds over a long session with insurance in play', () => {
  const t = table({ offerInsurance: true, startingBankroll: 100000, baseBet: 25 }, 3)
  const start = new Map(t.state.players.map((p) => [p.id, p.bankroll]))
  let offers = 0

  for (let round = 0; round < 400 && !t.isTableBroke; round++) {
    t.startRound()
    if (t.awaitingInsurance) {
      offers++
      let guard = 0
      for (;;) {
        const seat = t.insuranceSeat
        if (!seat || guard++ > 10) break
        t.takeInsurance(seat.id, (round + guard) % 2 === 0)
      }
      t.closeInsurance()
    }
    playOut(t)
    t.playDealerTurn()
    t.settle()

    for (const player of t.state.players) {
      assert.ok(player.bankroll >= 0, 'bankroll never goes negative')
      assert.equal(
        player.bankroll,
        (start.get(player.id) as number) + player.sessionNet,
        `${player.name} should equal start plus net after round ${round + 1}`
      )
    }
  }
  assert.ok(offers > 10, `insurance should come up regularly, saw ${offers}`)
})

test('the shoe reshuffles once it passes the cut card', () => {
  const t = table({ deckCount: 1 })
  let shuffles = 0
  for (let i = 0; i < 60; i++) {
    t.startRound()
    if (t.state.shoeJustShuffled) shuffles++
    playOut(t)
    t.playDealerTurn()
    t.settle()
    assert.ok(t.state.shoeRemaining >= 0)
  }
  assert.ok(shuffles > 0, 'a single deck must reshuffle during 60 rounds')
})
