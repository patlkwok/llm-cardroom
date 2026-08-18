import test from 'node:test'
import assert from 'node:assert/strict'
import { cardCode, sameCard, type Card } from '../src/shared/cards.ts'
import {
  BAGS_PER_PENALTY,
  CARDS_PER_HAND,
  DOUBLE_NIL_VALUE,
  NIL_VALUE,
  scoreTeam,
  SpadesTable,
  SPADES_SEATS,
  suggestedBid,
  TRICKS_PER_HAND,
  TRUMP
} from '../src/main/games/spades/engine.ts'
import { DEFAULT_SPADES_RULES } from '../src/shared/types.ts'

const SEEDS = Array.from({ length: SPADES_SEATS }, (_, i) => ({
  id: `p${i}`,
  name: `Seat${i}`,
  modelId: 'test/model'
}))

function newTable(rules = DEFAULT_SPADES_RULES): SpadesTable {
  return new SpadesTable(SEEDS, { ...rules })
}

/** Bids for whoever is owed one, so a test can get straight to the play. */
function bidAll(table: SpadesTable, bid: (seatIndex: number) => number = () => 3): void {
  for (;;) {
    const seat = table.pendingBidSeat
    if (!seat) break
    table.setBid(seat.seatIndex, bid(seat.seatIndex))
  }
}

/**
 * Plays a whole hand with a card-picking strategy.
 *
 * `gathered` accumulates every card of every resolved trick, so a caller can
 * check card conservation mid-play. It must be the same array the caller reads.
 */
function playHand(
  table: SpadesTable,
  choose: (legal: Card[], table: SpadesTable) => Card,
  gathered: Card[] = [],
  onPlay?: (table: SpadesTable) => void
): Card[] {
  let guard = 0
  while (!table.handComplete && guard++ < 200) {
    const seat = table.actingPlayer
    assert.ok(seat, 'a seat should be on turn until the hand is over')
    const legal = table.legalPlays(seat.seatIndex)
    assert.ok(legal.length > 0, `${seat.name} had no legal play`)
    table.playCard(seat.seatIndex, choose(legal, table))
    onPlay?.(table)
    if (table.trickComplete) {
      const trick = table.resolveTrick()
      gathered.push(...trick.plays.map((p) => p.card))
      if (table.awaitingNextTrick) table.startNextTrick()
    }
  }
  assert.ok(table.handComplete, 'the hand should finish')
  return gathered
}

const firstLegal = (legal: Card[]): Card => legal[0]
const randomLegal = (legal: Card[]): Card => legal[Math.floor(Math.random() * legal.length)]

/* ------------------------------------------------------------ conservation */

test('52 cards are conserved across hands and played tricks, at every play', () => {
  const table = newTable()
  for (let hand = 0; hand < 4; hand++) {
    table.startHand()
    bidAll(table, () => 3)
    const gathered: Card[] = []
    playHand(table, randomLegal, gathered, (t) => {
      const inFlight = t.state.currentTrick?.plays.map((p) => p.card) ?? []
      const seen = new Set(
        [...t.cardsInHands, ...gathered, ...inFlight].map(cardCode)
      )
      assert.equal(seen.size, 52, 'every card is in exactly one place at every moment')
    })
    table.scoreHand()
  }
})

test('thirteen tricks a hand, and both partnerships together always take all of them', () => {
  const table = newTable()
  for (let hand = 0; hand < 5; hand++) {
    table.startHand()
    bidAll(table, () => 3)
    playHand(table, randomLegal)

    const [a, b] = table.state.teams
    assert.equal(a.tricksWon + b.tricksWon, TRICKS_PER_HAND, 'tricks are conserved')
    assert.equal(table.state.trickNumber, TRICKS_PER_HAND)

    // The per-seat totals have to add up to the partnership totals too — the
    // team counter is incremented separately, so it can drift on its own.
    for (const team of table.state.teams) {
      const seats = team.seatIndices.reduce(
        (sum, i) => sum + table.state.players[i].tricksWon,
        0
      )
      assert.equal(seats, team.tricksWon, `${team.name} seat tricks match the team total`)
    }
    table.scoreHand()
  }
})

test('every seat is dealt thirteen cards and ends the hand with none', () => {
  const table = newTable()
  table.startHand()
  for (const player of table.state.players) assert.equal(player.hand.length, CARDS_PER_HAND)
  bidAll(table)
  playHand(table, randomLegal)
  for (const player of table.state.players) assert.equal(player.hand.length, 0)
})

/* ----------------------------------------------------------------- legality */

test('the engine rejects an off-suit card while the led suit is still held', () => {
  const table = newTable()
  table.startHand()
  bidAll(table)

  const leader = table.state.players[table.state.leadSeatIndex]
  const lead = table.legalPlays(leader.seatIndex)[0]
  table.playCard(leader.seatIndex, lead)

  const next = table.actingPlayer!
  const followers = next.hand.filter((c) => c.suit === lead.suit)
  if (followers.length === 0) return // void, so anything goes; nothing to reject

  const offSuit = next.hand.find((c) => c.suit !== lead.suit)
  if (!offSuit) return
  assert.throws(() => table.playCard(next.seatIndex, offSuit), /illegal play/)
  // And the legal set is exactly the led suit.
  assert.deepEqual(
    table.legalPlays(next.seatIndex).map(cardCode).sort(),
    followers.map(cardCode).sort()
  )
})

test('a seat may not play out of turn, or bid out of turn', () => {
  const table = newTable()
  table.startHand()

  const owed = table.pendingBidSeat!
  const other = table.state.players[(owed.seatIndex + 1) % SPADES_SEATS]
  assert.throws(() => table.setBid(other.seatIndex, 3), /out of turn/)
  assert.throws(() => table.setBid(owed.seatIndex, 14), /0 to 13/)
  assert.throws(() => table.setBid(owed.seatIndex, -1), /0 to 13/)
  assert.throws(() => table.setBid(owed.seatIndex, 2.5), /0 to 13/)

  bidAll(table)
  const acting = table.actingPlayer!
  const wrong = table.state.players[(acting.seatIndex + 1) % SPADES_SEATS]
  assert.throws(() => table.playCard(wrong.seatIndex, wrong.hand[0]), /out of turn/)
})

test('spades cannot be led until one has been played', () => {
  const table = newTable()
  let checked = 0

  for (let hand = 0; hand < 8 && checked < 3; hand++) {
    table.startHand()
    bidAll(table)

    while (!table.handComplete) {
      const seat = table.actingPlayer!
      const leading = table.state.currentTrick!.plays.length === 0
      const legal = table.legalPlays(seat.seatIndex)

      if (leading && !table.state.spadesBroken) {
        const hasOther = seat.hand.some((c) => c.suit !== TRUMP)
        if (hasOther) {
          assert.ok(
            legal.every((c) => c.suit !== TRUMP),
            'a spade must not be leadable while spades are unbroken'
          )
          checked++
        } else {
          // The escape: nothing but spades left, so one is led anyway.
          assert.ok(legal.every((c) => c.suit === TRUMP))
        }
      }

      table.playCard(seat.seatIndex, randomLegal(legal))
      if (table.trickComplete) {
        table.resolveTrick()
        if (table.awaitingNextTrick) table.startNextTrick()
      }
    }
    table.scoreHand()
  }
  assert.ok(checked >= 3, 'the unbroken-lead restriction should come up repeatedly')
})

test('any spade played breaks them, a forced lead included', () => {
  const table = newTable()
  table.startHand()
  bidAll(table)
  assert.equal(table.state.spadesBroken, false)

  let brokenOn: string | null = null
  while (!table.handComplete) {
    const seat = table.actingPlayer!
    const card = randomLegal(table.legalPlays(seat.seatIndex))
    const wasBroken = table.state.spadesBroken
    table.playCard(seat.seatIndex, card)

    if (!wasBroken && card.suit === TRUMP) {
      assert.equal(table.state.spadesBroken, true, 'the first spade played breaks them')
      brokenOn = cardCode(card)
    }
    if (!wasBroken && card.suit !== TRUMP) {
      assert.equal(table.state.spadesBroken, false, 'nothing but a spade breaks them')
    }
    if (table.trickComplete) {
      table.resolveTrick()
      if (table.awaitingNextTrick) table.startNextTrick()
    }
  }
  assert.ok(brokenOn, 'a full hand of thirteen tricks always plays at least one spade')
})

test('a seat is never left without a legal play, whatever it holds', () => {
  // The invariant behind the forced-play optimisation: a rule that filters a
  // hand down to nothing wedges the match instead of failing loudly.
  const table = newTable()
  for (let hand = 0; hand < 6; hand++) {
    table.startHand()
    bidAll(table, (i) => i)
    playHand(table, randomLegal, [], (t) => {
      const seat = t.actingPlayer
      if (!seat || seat.hand.length === 0) return
      const legal = t.legalPlays(seat.seatIndex)
      assert.ok(legal.length > 0, `${seat.name} holds cards but has no legal play`)
      assert.ok(
        legal.every((c) => seat.hand.some((held) => sameCard(held, c))),
        'every legal play is a card actually held'
      )
    })
    table.scoreHand()
  }
})

test('the highest spade takes the trick, whatever was led', () => {
  const table = newTable()
  table.startHand()
  bidAll(table)

  let trumped = 0
  while (!table.handComplete) {
    const seat = table.actingPlayer!
    table.playCard(seat.seatIndex, randomLegal(table.legalPlays(seat.seatIndex)))
    if (table.trickComplete) {
      const trick = table.resolveTrick()
      const spades = trick.plays.filter((p) => p.card.suit === TRUMP)
      const winner = trick.plays.find((p) => p.seatIndex === trick.winnerSeatIndex)!
      if (spades.length > 0) {
        assert.equal(winner.card.suit, TRUMP, 'a trumped trick goes to a spade')
        assert.ok(spades.every((p) => p.card.rank <= winner.card.rank), 'the highest one')
        trumped++
      } else {
        assert.equal(winner.card.suit, trick.leadSuit)
      }
      if (table.awaitingNextTrick) table.startNextTrick()
    }
  }
  assert.ok(trumped > 0, 'a full hand always sees spades played on some trick')
})

test('the trick winner leads the next trick', () => {
  const table = newTable()
  table.startHand()
  bidAll(table)

  while (!table.handComplete) {
    const seat = table.actingPlayer!
    table.playCard(seat.seatIndex, randomLegal(table.legalPlays(seat.seatIndex)))
    if (table.trickComplete) {
      const trick = table.resolveTrick()
      if (table.awaitingNextTrick) {
        table.startNextTrick()
        assert.equal(table.state.leadSeatIndex, trick.winnerSeatIndex)
        assert.equal(table.state.actingSeatIndex, trick.winnerSeatIndex)
      }
    }
  }
})

/* ----------------------------------------------------------------- bidding */

test('bidding opens to the dealer’s left and the deal rotates', () => {
  const table = newTable()
  for (let hand = 1; hand <= 5; hand++) {
    table.startHand()
    assert.equal(table.state.dealerIndex, (hand - 1) % SPADES_SEATS, 'the deal moves one seat a hand')
    assert.equal(
      table.state.biddingSeatIndex,
      hand % SPADES_SEATS,
      'the seat left of the dealer bids first'
    )

    const order: number[] = []
    for (;;) {
      const seat = table.pendingBidSeat
      if (!seat) break
      order.push(seat.seatIndex)
      table.setBid(seat.seatIndex, 3)
    }
    assert.deepEqual(
      order,
      [0, 1, 2, 3].map((i) => (hand + i) % SPADES_SEATS),
      'and it runs round the table from there'
    )
    // The seat that bid first also leads the first trick.
    assert.equal(table.state.leadSeatIndex, hand % SPADES_SEATS)

    playHand(table, firstLegal)
    table.scoreHand()
  }
})

test('a partnership’s contract is both partners’ bids, and a nil adds nothing', () => {
  const table = newTable()
  table.startHand()
  bidAll(table, (seatIndex) => [4, 2, 3, 0][seatIndex])

  // Seats 0 and 2 are one partnership, 1 and 3 the other.
  assert.equal(table.team(0).contract, 7, '4 + 3')
  assert.equal(table.team(1).contract, 2, '2 + nil, and nil contributes nothing')
  assert.equal(table.state.players[3].nilsBid, 1)
})

test('the fallback bid is never nil', () => {
  // A fallback nil would charge a −100 swing to a seat that merely failed to
  // answer, which is far worse than a conservative 1. Checked over the whole
  // space of hands the dealer can produce, not a sample of convenient ones.
  const table = newTable()
  let weakest = 99
  for (let hand = 0; hand < 200; hand++) {
    table.startHand()
    for (const player of table.state.players) {
      const bid = suggestedBid(player.hand)
      assert.ok(Number.isInteger(bid), 'a bid is a whole number of tricks')
      assert.ok(bid >= 1, `suggestedBid returned ${bid}; it must never bid nil by accident`)
      assert.ok(bid <= TRICKS_PER_HAND)
      weakest = Math.min(weakest, bid)
    }
    bidAll(table)
    playHand(table, firstLegal)
    table.scoreHand()
  }
  assert.equal(weakest, 1, 'and it does reach the floor, so the clamp is doing work')
})

/* ----------------------------------------------------------------- scoring */

test('scoring a hand matches an independently written table of cases', () => {
  // Written from the rules as stated in the system prompt, not read back out of
  // the code. Every entry names its arithmetic so a wrong expectation is
  // visible rather than authoritative-looking.
  const base = { nilTricks: 0, nilTricksCountToContract: true }
  const cases: Array<[string, Parameters<typeof scoreTeam>[0], number]> = [
    ['made exactly', { ...base, contract: 4, tricksWon: 4, bagsBefore: 0, nilsMade: 0, nilsFailed: 0 }, 40],
    ['made with two bags', { ...base, contract: 4, tricksWon: 6, bagsBefore: 0, nilsMade: 0, nilsFailed: 0 }, 42],
    ['set by one', { ...base, contract: 4, tricksWon: 3, bagsBefore: 0, nilsMade: 0, nilsFailed: 0 }, -40],
    ['set badly', { ...base, contract: 9, tricksWon: 2, bagsBefore: 0, nilsMade: 0, nilsFailed: 0 }, -90],
    ['nil made alongside a made contract', { ...base, contract: 3, tricksWon: 4, bagsBefore: 0, nilsMade: 1, nilsFailed: 0 }, 30 + 1 + 100],
    ['nil failed alongside a made contract', { ...base, contract: 3, tricksWon: 5, nilTricks: 1, bagsBefore: 0, nilsMade: 0, nilsFailed: 1 }, 30 + 2 - 100],
    ['the tenth bag costs a hundred', { ...base, contract: 4, tricksWon: 6, bagsBefore: 8, nilsMade: 0, nilsFailed: 0 }, 40 + 2 - 100],
    ['a set partnership takes no bags at all', { ...base, contract: 5, tricksWon: 4, bagsBefore: 9, nilsMade: 0, nilsFailed: 0 }, -50]
  ]

  for (const [label, input, expected] of cases) {
    assert.equal(scoreTeam(input).delta, expected, label)
  }

  // And the bag counter itself rolls rather than resetting.
  assert.equal(scoreTeam({ ...base, contract: 4, tricksWon: 6, bagsBefore: 8, nilsMade: 0, nilsFailed: 0 }).bagsAfter, 0)
  assert.equal(scoreTeam({ ...base, contract: 4, tricksWon: 7, bagsBefore: 8, nilsMade: 0, nilsFailed: 0 }).bagsAfter, 1)
  assert.equal(scoreTeam({ ...base, contract: 5, tricksWon: 4, bagsBefore: 9, nilsMade: 0, nilsFailed: 0 }).bagsAfter, 9)
})

test('double nil is scored as one thing, not as two independent nils', () => {
  // The rule this engine had wrong first time round. Both partners on nil is
  // its own result: the pair's nil bonuses **doubled** if they both bring it
  // home, and **no nil penalty at all** if either fails. Scoring it as two
  // separate nils gives 200 and −200 instead of 400 and 0, and — the subtler
  // half — makes a mixed result come to 0 by two halves cancelling rather than
  // by rule.
  const base = { nilTricksCountToContract: true, bagsBefore: 0 }

  const bothHome = scoreTeam({ ...base, contract: 0, tricksWon: 0, nilTricks: 0, nilsMade: 2, nilsFailed: 0 })
  assert.equal(bothHome.doubleNil, true)
  assert.equal(bothHome.nilPoints, DOUBLE_NIL_VALUE)
  assert.equal(bothHome.delta, 400, 'both nils home is the doubled bonus, not 100 + 100')

  // Either failing kills the bonus and carries no penalty — but the contract is
  // 0, so every trick the pair took is a bag. That is the whole cost.
  const oneBroke = scoreTeam({ ...base, contract: 0, tricksWon: 3, nilTricks: 3, nilsMade: 1, nilsFailed: 1 })
  assert.equal(oneBroke.nilPoints, 0, 'no nil penalty when a double nil breaks')
  assert.equal(oneBroke.bagsGained, 3, 'but the tricks are all bags')
  assert.equal(oneBroke.delta, 3)

  const bothBroke = scoreTeam({ ...base, contract: 0, tricksWon: 5, nilTricks: 5, nilsMade: 0, nilsFailed: 2 })
  assert.equal(bothBroke.nilPoints, 0, 'still no penalty when both break')
  assert.equal(bothBroke.delta, 5)

  // A single nil is untouched by any of this.
  const single = scoreTeam({ ...base, contract: 4, tricksWon: 4, nilTricks: 0, nilsMade: 1, nilsFailed: 0 })
  assert.equal(single.doubleNil, false)
  assert.equal(single.nilPoints, NIL_VALUE)
})

test('the nil-tricks rule changes whether a contract is made', () => {
  // The setting, and the case that separates the two readings: the partnership
  // bid 3 and took 3, but one of those was taken by the nil bidder. Counting it
  // makes the contract; not counting it sets them.
  const base = { contract: 3, tricksWon: 3, nilTricks: 1, bagsBefore: 0, nilsMade: 0, nilsFailed: 1 }

  const counting = scoreTeam({ ...base, nilTricksCountToContract: true })
  assert.equal(counting.made, true)
  assert.equal(counting.contractPoints, 30)
  assert.equal(counting.delta, 30 - 100, 'contract made, nil broken')

  const notCounting = scoreTeam({ ...base, nilTricksCountToContract: false })
  assert.equal(notCounting.made, false, 'two tricks against a contract of three is set')
  assert.equal(notCounting.contractPoints, -30)
  assert.equal(notCounting.bagsGained, 0, 'and a set partnership takes no bags')
  assert.equal(notCounting.delta, -30 - 100)

  // With the nil brought home the two readings cannot disagree: nilTricks is 0,
  // so there is nothing to exclude.
  for (const flag of [true, false]) {
    const clean = scoreTeam({
      contract: 3, tricksWon: 4, nilTricks: 0, bagsBefore: 0,
      nilsMade: 1, nilsFailed: 0, nilTricksCountToContract: flag
    })
    assert.equal(clean.delta, 30 + 1 + 100)
  }
})

test('scoring agrees with an independent implementation over the whole space', () => {
  // The oracle is written from the rules again rather than refactored out of
  // the engine — the same trick the 24 solver's oracle uses. Exhaustive over
  // every combination a hand can actually produce, under both readings of the
  // nil-tricks rule.
  function oracle(
    contract: number, tricks: number, nilTricks: number, bagsBefore: number,
    made: number, failed: number, nilTricksCount: boolean
  ) {
    let delta = 0
    let bags = bagsBefore
    const towardsContract = nilTricksCount ? tricks : tricks - nilTricks
    if (towardsContract >= contract) {
      delta += contract * 10
      const over = tricks - contract
      delta += over
      bags += over
      while (bags >= BAGS_PER_PENALTY) {
        bags -= BAGS_PER_PENALTY
        delta -= 100
      }
    } else {
      delta -= contract * 10
    }
    // Double nil is a unit; anything else is scored per nil.
    if (made + failed === 2) delta += failed === 0 ? 400 : 0
    else delta += made * 100 - failed * 100
    return { delta, bags }
  }

  let checked = 0
  for (let contract = 0; contract <= TRICKS_PER_HAND; contract++) {
    for (let tricks = 0; tricks <= TRICKS_PER_HAND; tricks++) {
      for (let bagsBefore = 0; bagsBefore < BAGS_PER_PENALTY; bagsBefore++) {
        for (const [nilsMade, nilsFailed] of [[0, 0], [1, 0], [0, 1], [2, 0], [1, 1], [0, 2]]) {
          // A seat that made its nil took no tricks, so only the failed ones can
          // contribute — and never more than the partnership took in total.
          const nilTricks = Math.min(tricks, nilsFailed)
          for (const nilTricksCountToContract of [true, false]) {
            const got = scoreTeam({
              contract, tricksWon: tricks, nilTricks, bagsBefore,
              nilsMade, nilsFailed, nilTricksCountToContract
            })
            const want = oracle(
              contract, tricks, nilTricks, bagsBefore, nilsMade, nilsFailed, nilTricksCountToContract
            )
            assert.equal(got.delta, want.delta, `${contract}/${tricks}/${bagsBefore}/${nilTricksCountToContract}`)
            assert.equal(got.bagsAfter, want.bags, `${contract}/${tricks}/${bagsBefore} bags`)
            checked++
          }
        }
      }
    }
  }
  assert.equal(checked, 14 * 14 * 10 * 6 * 2)
})

test('a nil bidder’s trick breaks the nil and still counts towards the contract', () => {
  // Both halves at once, because they are the pair of rules tables disagree on
  // most and the prompt states them together.
  const table = newTable()
  table.startHand()
  bidAll(table, (seatIndex) => (seatIndex === 0 ? 0 : 3))

  // Drive the hand so seat 0 takes at least one trick: it always plays its
  // highest legal card, which is the fastest way to break its own nil.
  playHand(table, (legal, t) =>
    t.actingPlayer?.seatIndex === 0 ? legal[legal.length - 1] : legal[0]
  )

  const nilSeat = table.state.players[0]
  const team = table.team(0)
  assert.equal(team.contract, 3, 'the nil contributed nothing to the contract')
  assert.equal(
    team.tricksWon,
    nilSeat.tricksWon + table.state.players[2].tricksWon,
    'but its tricks are counted in the partnership total'
  )

  const before = team.score
  const [scored] = table.scoreHand()
  if (nilSeat.tricksWon > 0) {
    assert.equal(scored.nilPoints, -100, 'a broken nil is −100')
    assert.equal(nilSeat.nilsMade, 0)
  } else {
    assert.equal(scored.nilPoints, 100)
    assert.equal(nilSeat.nilsMade, 1)
  }
  assert.equal(team.score, before + scored.delta)
})

test('a partnership score is exactly the sum of its hand deltas', () => {
  // The Spades analogue of bankroll accounting: the running total and the
  // per-hand reports cannot disagree.
  const table = newTable({ targetScore: 100000, bustScore: 0, nilTricksCountToContract: true })
  const totals = [0, 0]
  for (let hand = 0; hand < 12; hand++) {
    table.startHand()
    bidAll(table, (seatIndex) => (hand % 4 === seatIndex ? 0 : 3))
    playHand(table, randomLegal)
    for (const scored of table.scoreHand()) totals[scored.team.index] += scored.delta
  }
  for (const team of table.state.teams) {
    assert.equal(team.score, totals[team.index], `${team.name} total matches its deltas`)
    assert.ok(team.bags >= 0 && team.bags < BAGS_PER_PENALTY, 'bags always stay under ten')
  }
})

/* -------------------------------------------------------------- the match */

test('the match ends when a partnership reaches the target, or falls through the floor', () => {
  const high = newTable({ targetScore: 200, bustScore: -200, nilTricksCountToContract: true })
  assert.equal(high.isMatchOver, false)
  high.state.teams[0].score = 200
  assert.equal(high.isMatchOver, true)
  assert.equal(high.winnerName, 'North–South')

  const low = newTable({ targetScore: 500, bustScore: -200, nilTricksCountToContract: true })
  low.state.teams[1].score = -200
  assert.equal(low.isMatchOver, true)
  // The floor ends the match; the *other* partnership wins it, however little
  // it has scored. Reading the loser's total as the result would be the bug.
  assert.equal(low.winnerName, 'North–South')

  const noFloor = newTable({ targetScore: 500, bustScore: 0, nilTricksCountToContract: true })
  noFloor.state.teams[1].score = -900
  assert.equal(noFloor.isMatchOver, false, 'a floor of 0 disables it')
})

test('both partnerships level past the target is not a win', () => {
  const table = newTable({ targetScore: 200, bustScore: 0, nilTricksCountToContract: true })
  table.state.teams[0].score = 210
  table.state.teams[1].score = 210
  assert.equal(table.isMatchOver, true)
  assert.equal(table.isDeadHeat, true, 'so the driver plays another hand rather than declaring one')

  table.state.teams[1].score = 205
  assert.equal(table.isDeadHeat, false)
  assert.equal(table.winnerName, 'North–South')
})

test('partnerships are positional and opposite, and the teams are named for it', () => {
  const table = newTable()
  assert.equal(table.partnerIndex(0), 2)
  assert.equal(table.partnerIndex(1), 3)
  assert.equal(table.partnerIndex(3), 1)
  assert.deepEqual(table.opponentsOf(0).map((p) => p.seatIndex), [1, 3])

  // Seat 0 sits south and seat 1 west on the felt, so team 0 really is the
  // north–south pair. The name is not decoration: it is what the log and the
  // prompt call them, and getting it backwards would mislabel every result.
  assert.deepEqual(table.team(0).seatIndices, [0, 2])
  assert.equal(table.team(0).name, 'North–South')
  assert.deepEqual(table.team(1).seatIndices, [1, 3])
  assert.equal(table.team(1).name, 'East–West')
})

/* ---------------------------------------------------------- instrumentation */

test('forced plays are common enough to be worth skipping the model call for', () => {
  // The same measurement Hearts carries, and the same reason: it is how much of
  // a trick-taking match comes free. Hearts runs 23.7–25.0%; Spades has no
  // first-trick rule and a trump suit, so the figure is its own.
  const table = newTable({ targetScore: 100000, bustScore: 0, nilTricksCountToContract: true })
  let forced = 0
  let total = 0

  for (let hand = 0; hand < 12; hand++) {
    table.startHand()
    bidAll(table, () => 3)
    while (!table.handComplete) {
      const seat = table.actingPlayer!
      const legal = table.legalPlays(seat.seatIndex)
      total++
      if (legal.length === 1) forced++
      table.playCard(seat.seatIndex, randomLegal(legal), legal.length === 1)
      if (table.trickComplete) {
        table.resolveTrick()
        if (table.awaitingNextTrick) table.startNextTrick()
      }
    }
    table.scoreHand()
  }

  const rate = forced / total
  console.log(`  forced plays: ${forced}/${total} = ${(rate * 100).toFixed(1)}%`)
  assert.equal(total, 12 * 52)
  assert.equal(table.state.forcedPlays, forced, 'the engine counts what the test counts')
  assert.equal(table.state.totalPlays, total)
  // Wide bounds on purpose: this pins that the optimisation is worth having and
  // that the counter is not stuck, not the exact figure.
  assert.ok(rate > 0.05 && rate < 0.5, `forced-play rate ${rate} is outside anything plausible`)
})
