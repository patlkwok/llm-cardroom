import test from 'node:test'
import assert from 'node:assert/strict'
import { cardCode, type Card } from '../src/shared/cards.ts'
import {
  CARDS_PER_HAND,
  cardPoints,
  HeartsTable,
  HEARTS_SEATS,
  POINTS_PER_HAND,
  QUEEN_OF_SPADES,
  sameCard,
  TWO_OF_CLUBS
} from '../src/main/games/hearts/engine.ts'
import { DEFAULT_HEARTS_RULES } from '../src/shared/types.ts'

const SEEDS = Array.from({ length: HEARTS_SEATS }, (_, i) => ({
  id: `p${i}`,
  name: `Seat${i}`,
  modelId: 'test/model'
}))

function newTable(targetScore = DEFAULT_HEARTS_RULES.targetScore): HeartsTable {
  return new HeartsTable(SEEDS, { targetScore })
}

/** Every card the engine currently accounts for: hands plus every trick played. */
function allCards(table: HeartsTable, tricks: Card[]): Card[] {
  return [...table.cardsInHands, ...tricks, ...(table.state.currentTrick?.plays.map((p) => p.card) ?? [])]
}

function key(card: Card): string {
  return cardCode(card)
}

/**
 * Answers the pass for every seat and runs the exchange right through to the
 * first lead, so a test can get straight to the play.
 *
 * The exchange is three steps now, not one: the runner shows the cards leaving
 * each hand and then the cards arriving, each for a beat of its own.
 */
function passAnything(table: HeartsTable): void {
  if (!table.passing) return
  for (;;) {
    const seat = table.pendingPassSeat
    if (!seat) break
    table.setPass(seat.id, seat.hand.slice(0, 3))
  }
  table.revealPass()
  table.completePass()
  table.beginPlay()
}

/**
 * Plays a whole hand with a card-picking strategy.
 *
 * `gathered` accumulates every card of every resolved trick, so a caller can
 * check card conservation mid-play. It must be the same array the caller reads:
 * handing back a fresh one is how the first version of this silently "lost"
 * four cards per trick and failed for the wrong reason.
 */
function playHand(
  table: HeartsTable,
  choose: (legal: Card[], table: HeartsTable) => Card,
  gathered: Card[] = [],
  onPlay?: (table: HeartsTable) => void
): Card[] {
  passAnything(table)

  let guard = 0
  while (!table.handComplete && guard++ < 200) {
    const seat = table.actingPlayer
    assert.ok(seat, 'a seat should be on turn until the hand is over')
    const legal = table.legalPlays(seat.seatIndex)
    assert.ok(legal.length > 0, `${seat.name} had no legal play`)
    const card = choose(legal, table)
    table.playCard(seat.seatIndex, card)
    onPlay?.(table)
    if (table.trickComplete) {
      const trick = table.resolveTrick()
      gathered.push(...trick.plays.map((p) => p.card))
      // Resolving no longer opens the next trick — the runner shows the result
      // for a beat first — so a test driving the engine has to advance it.
      if (table.awaitingNextTrick) table.startNextTrick()
    }
  }
  return gathered
}

const pickFirst = (legal: Card[]): Card => legal[0]

/* ------------------------------------------------------ card conservation */

test('52 cards are conserved across hands and played tricks, at every play', () => {
  const table = newTable()

  for (let hand = 0; hand < 4; hand++) {
    table.startHand()

    // Straight after the deal, every card is in somebody's hand.
    assert.equal(table.cardsInHands.length, 52, 'the deal accounts for all 52')
    assert.equal(new Set(table.cardsInHands.map(key)).size, 52, 'and no card is duplicated')

    const gathered: Card[] = []
    playHand(table, pickFirst, gathered, (t) => {
      // The invariant has to hold mid-trick too, not just at trick boundaries:
      // that is where a card can go missing between a hand and a trick.
      const seen = allCards(t, gathered)
      assert.equal(seen.length, 52, `card count drifted to ${seen.length}`)
      assert.equal(new Set(seen.map(key)).size, 52, 'a card was duplicated')
    })
    assert.equal(gathered.length, 52, 'every card ended up in a resolved trick')
    table.scoreHand()
  }
})

test('every seat is dealt thirteen cards and plays exactly thirteen tricks', () => {
  const table = newTable()
  table.startHand()
  for (const player of table.state.players) {
    assert.equal(player.hand.length, CARDS_PER_HAND, `${player.name} was dealt ${player.hand.length}`)
  }

  playHand(table, pickFirst)
  assert.equal(table.state.trickNumber, CARDS_PER_HAND, '13 tricks to a hand, always')
  for (const player of table.state.players) {
    assert.equal(player.hand.length, 0, `${player.name} still holds cards`)
  }
  const tricksWon = table.state.players.reduce((sum, p) => sum + p.tricksWon, 0)
  assert.equal(tricksWon, CARDS_PER_HAND, 'every trick was won by exactly one seat')
})

/* ---------------------------------------------------- points conservation */

test('exactly 26 points are distributed each hand, unless the moon is shot', () => {
  for (let hand = 0; hand < 25; hand++) {
    const table = newTable(10_000)
    table.startHand()
    // A little randomness so the sample is not one strategy's worth of hands.
    playHand(table, (legal) => legal[Math.floor(Math.random() * legal.length)])

    const inHand = table.state.players.reduce((sum, p) => sum + p.handScore, 0)
    assert.equal(inHand, POINTS_PER_HAND, `the tricks carried ${inHand} points, not 26`)

    const { moonShooter, awarded } = table.scoreHand()
    const scored = awarded.reduce((sum, a) => sum + a.points, 0)
    if (moonShooter) {
      assert.equal(scored, POINTS_PER_HAND * (HEARTS_SEATS - 1), 'a moon scores 26 to each of the others')
      assert.equal(moonShooter.lastHandScore, 0, 'and nothing to the shooter')
    } else {
      assert.equal(scored, POINTS_PER_HAND, `${scored} points were awarded, not 26`)
    }
  }
})

test('shooting the moon scores 26 to everybody else and nothing to the shooter', () => {
  // Driven straight at `scoreHand` rather than through a rigged 13-trick deal.
  // A deal that funnels all 26 to one seat has to satisfy the two-of-clubs
  // lead, the no-points-on-trick-one rule and follow-suit legality all at once,
  // and the first attempt at one was quietly self-contradictory. The rule under
  // test lives entirely in `scoreHand`, so that is what this drives; the
  // conservation test above covers the played path over 25 random hands.
  const table = newTable(10_000)
  table.startHand()
  const s = table.state
  s.phase = 'handComplete'
  s.players[0].handScore = POINTS_PER_HAND
  s.players[1].handScore = 0
  s.players[2].handScore = 0
  s.players[3].handScore = 0

  const { moonShooter, awarded } = table.scoreHand()
  assert.equal(moonShooter?.seatIndex, 0, 'the seat holding all 26 is the shooter')
  assert.equal(awarded[0].points, 0, 'the shooter scores nothing')
  assert.equal(s.players[0].totalScore, 0)
  for (const other of awarded.slice(1)) {
    assert.equal(other.points, POINTS_PER_HAND, `${other.player.name} should take 26`)
    assert.equal(other.player.totalScore, POINTS_PER_HAND)
  }
  assert.equal(s.players[0].moonShots, 1)
  // The summary reaches the felt and the table log, so assert the string too.
  assert.match(s.lastHandSummary ?? '', /shot the moon/i)
})

test('taking 25 of the 26 is not a moon — it is a disaster', () => {
  // One point short is the case that makes shooting a gamble, so pin it.
  const table = newTable(10_000)
  table.startHand()
  const s = table.state
  s.phase = 'handComplete'
  s.players[0].handScore = POINTS_PER_HAND - 1
  s.players[1].handScore = 1
  s.players[2].handScore = 0
  s.players[3].handScore = 0

  const { moonShooter, awarded } = table.scoreHand()
  assert.equal(moonShooter, undefined, '25 points is not a moon')
  assert.equal(awarded[0].points, POINTS_PER_HAND - 1, 'the near-shooter eats all 25')
  assert.equal(awarded[1].points, 1)
  assert.equal(s.players[0].moonShots, 0)
})

/* ------------------------------------------------------------- legality */

test('the two of clubs is the only legal opening play', () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const table = newTable()
    table.startHand()
    passAnything(table)

    const leader = table.actingPlayer
    assert.ok(leader)
    assert.ok(
      leader.hand.some((c) => sameCard(c, TWO_OF_CLUBS)),
      'the seat on lead must be the one holding the two of clubs'
    )
    const legal = table.legalPlays(leader.seatIndex)
    assert.equal(legal.length, 1, 'the opening lead is forced')
    assert.ok(sameCard(legal[0], TWO_OF_CLUBS))
  }
})

test('the engine rejects an off-suit card while the led suit is still held', () => {
  const table = newTable()
  table.startHand()
  passAnything(table)

  // Open the trick, then find a follower that can actually follow suit.
  const leader = table.actingPlayer!
  table.playCard(leader.seatIndex, TWO_OF_CLUBS)

  let checked = 0
  while (!table.trickComplete) {
    const seat = table.actingPlayer!
    const legal = table.legalPlays(seat.seatIndex)
    const holdsClubs = seat.hand.some((c) => c.suit === 'c')

    if (holdsClubs) {
      // Legality is not merely "the legal ones work" — the engine must refuse.
      const offSuit = seat.hand.find((c) => c.suit !== 'c')
      if (offSuit) {
        assert.throws(
          () => table.playCard(seat.seatIndex, offSuit),
          /illegal play/,
          `${seat.name} was allowed to play ${cardCode(offSuit)} while holding clubs`
        )
        checked++
      }
      assert.ok(legal.every((c) => c.suit === 'c'), 'only clubs are legal while clubs are held')
    }
    table.playCard(seat.seatIndex, legal[0])
  }
  assert.ok(checked > 0, 'at least one follower should have been able to follow suit')
})

test('a seat may not play out of turn', () => {
  const table = newTable()
  table.startHand()
  passAnything(table)
  const onLead = table.state.actingSeatIndex
  const other = (onLead + 1) % HEARTS_SEATS
  assert.throws(
    () => table.playCard(other, table.state.players[other].hand[0]),
    /out of turn/
  )
})

test('no points fall on the first trick', () => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const table = newTable()
    table.startHand()
    if (table.passing) {
      for (;;) {
        const seat = table.pendingPassSeat
        if (!seat) break
        // Pass points where possible, to push the engine towards the case.
        const points = seat.hand.filter((c) => cardPoints(c) > 0)
        const pass = [...points, ...seat.hand.filter((c) => cardPoints(c) === 0)].slice(0, 3)
        table.setPass(seat.id, pass)
      }
      table.revealPass()
      table.completePass()
      table.beginPlay()
    }

    while (!table.trickComplete) {
      const seat = table.actingPlayer!
      const legal = table.legalPlays(seat.seatIndex)
      // Deliberately try to dump points into the first trick.
      const nastiest = [...legal].sort((a, b) => cardPoints(b) - cardPoints(a))[0]
      table.playCard(seat.seatIndex, nastiest)
    }
    const trick = table.resolveTrick()
    assert.equal(
      trick.points,
      0,
      `the first trick carried ${trick.points} points: ${trick.plays.map((p) => cardCode(p.card)).join(' ')}`
    )
  }
})

test('hearts cannot be led until one has actually been played', () => {
  const table = newTable()
  table.startHand()
  const s = table.state
  s.phase = 'playing'
  s.heartsBroken = false
  s.trickNumber = 1
  // A seat on lead holding both hearts and non-hearts may lead only non-hearts.
  s.players[0].hand = [
    { rank: 5, suit: 'h' },
    { rank: 9, suit: 'd' },
    { rank: 3, suit: 'c' }
  ]
  s.leadSeatIndex = 0
  s.actingSeatIndex = 0
  s.currentTrick = { number: 2, leadSuit: 'c', plays: [], points: 0 }
  s.trickNumber = 2

  const legal = table.legalPlays(0)
  assert.ok(!legal.some((c) => c.suit === 'h'), 'hearts must not be leadable while unbroken')
  assert.equal(legal.length, 2)

  // A seat left holding nothing but hearts may lead them anyway.
  s.players[0].hand = [
    { rank: 5, suit: 'h' },
    { rank: 9, suit: 'h' }
  ]
  const forced = table.legalPlays(0)
  assert.equal(forced.length, 2, 'holding only hearts, both are legal leads')
  assert.ok(forced.every((c) => c.suit === 'h'))
})

test('the queen of spades does not break hearts — only a heart does', () => {
  const table = newTable()
  table.startHand()
  const s = table.state
  s.phase = 'playing'
  s.heartsBroken = false
  s.trickNumber = 3
  s.leadSeatIndex = 0
  s.actingSeatIndex = 0
  s.currentTrick = { number: 3, leadSuit: 'd', plays: [], points: 0 }

  // Seat 0 leads a diamond; seat 1 is void and discards the queen of spades.
  s.players[0].hand = [{ rank: 4, suit: 'd' }, { rank: 7, suit: 'c' }]
  s.players[1].hand = [QUEEN_OF_SPADES, { rank: 3, suit: 'c' }]
  s.players[2].hand = [{ rank: 5, suit: 'd' }, { rank: 8, suit: 'c' }]
  s.players[3].hand = [{ rank: 6, suit: 'd' }, { rank: 9, suit: 'c' }]

  table.playCard(0, { rank: 4, suit: 'd' })
  table.playCard(1, QUEEN_OF_SPADES)

  assert.equal(s.queenPlayed, true, 'the queen is recorded as played')
  assert.equal(
    s.heartsBroken,
    false,
    'the queen of spades must NOT break hearts — this is the rule people get wrong'
  )

  // And now an actual heart does break them.
  s.players[2].hand = [{ rank: 5, suit: 'h' }]
  table.playCard(2, { rank: 5, suit: 'h' })
  assert.equal(s.heartsBroken, true, 'a heart breaks hearts')
})

test('holding only the queen and hearts with hearts unbroken, the queen is forced', () => {
  // The case people complain about online, and a deliberate consequence of the
  // pinned rules: hearts are still barred, and the queen is a legal lead.
  const table = newTable()
  table.startHand()
  const s = table.state
  s.phase = 'playing'
  s.heartsBroken = false
  s.trickNumber = 4
  s.leadSeatIndex = 0
  s.actingSeatIndex = 0
  s.currentTrick = { number: 4, leadSuit: 'c', plays: [], points: 0 }
  s.players[0].hand = [
    QUEEN_OF_SPADES,
    { rank: 4, suit: 'h' },
    { rank: 10, suit: 'h' }
  ]

  const legal = table.legalPlays(0)
  assert.equal(legal.length, 1, 'the lead is forced')
  assert.ok(sameCard(legal[0], QUEEN_OF_SPADES), 'and it is the queen of spades')
})

/* ---------------------------------------------------------------- passing */

test('the pass rotates left, right, across, hold and moves three cards each way', () => {
  const table = newTable(10_000)
  const seen: string[] = []

  for (let hand = 0; hand < 4; hand++) {
    table.startHand()
    seen.push(table.state.passDirection)

    if (table.state.passDirection === 'hold') {
      assert.equal(table.passing, false, 'a hold hand needs no pass at all')
      assert.equal(table.state.phase, 'playing')
    } else {
      const before = table.state.players.map((p) => p.hand.map(cardCode).slice(0, 3).join(' '))
      for (;;) {
        const seat = table.pendingPassSeat
        if (!seat) break
        table.setPass(seat.id, seat.hand.slice(0, 3))
      }

      // The cards are named before they move, and are still held at that point:
      // that is the whole reason the reveal is a step of its own.
      table.revealPass()
      for (const player of table.state.players) {
        assert.equal(player.hand.length, CARDS_PER_HAND, 'nothing has moved yet')
        assert.equal(player.passedCards.length, 3, 'but the three leaving are named')
        for (const card of player.passedCards) {
          assert.ok(
            player.hand.some((held) => sameCard(held, card)),
            `${player.name} is shown passing ${cardCode(card)} but no longer holds it`
          )
        }
      }

      table.completePass()
      table.beginPlay()

      for (const player of table.state.players) {
        assert.equal(player.hand.length, CARDS_PER_HAND, 'hands stay at 13 through the exchange')
        assert.equal(player.passedCards.length, 3)
        assert.equal(player.receivedCards.length, 3)
        // What a seat passed must be exactly what its recipient received.
        const recipient = table.state.players[table.passRecipient(player.seatIndex)]
        assert.deepEqual(
          recipient.receivedCards.map(cardCode).sort(),
          player.passedCards.map(cardCode).sort(),
          `${player.name}'s pass did not arrive at ${recipient.name}`
        )
        // And a seat must not still hold what it passed away.
        for (const card of player.passedCards) {
          assert.ok(
            !player.hand.some((held) => sameCard(held, card)),
            `${player.name} kept ${cardCode(card)} after passing it`
          )
        }
      }
      assert.equal(new Set(table.cardsInHands.map(cardCode)).size, 52, 'no card was lost or cloned')
      assert.ok(before.length === HEARTS_SEATS)
    }
    playHand(table, pickFirst)
    table.scoreHand()
  }

  assert.deepEqual(seen, ['left', 'right', 'across', 'hold'], 'the cycle is left, right, across, hold')
})

test('a pass must be three cards the seat actually holds', () => {
  const table = newTable()
  table.startHand()
  const seat = table.pendingPassSeat
  assert.ok(seat)

  assert.throws(() => table.setPass(seat.id, seat.hand.slice(0, 2)), /exactly 3 cards/)
  const notHeld = seat.hand[0]
  const others = table.state.players.find((p) => p.id !== seat.id)!
  const foreign = others.hand.find((c) => !seat.hand.some((h) => sameCard(h, c)))!
  assert.throws(() => table.setPass(seat.id, [notHeld, foreign, seat.hand[1]]), /does not hold/)
})

/* ----------------------------------------------------------- match end */

test('the match ends once a seat reaches the target score', () => {
  const table = newTable(30)
  let guard = 0
  while (!table.isMatchOver && guard++ < 40) {
    table.startHand()
    playHand(table, pickFirst)
    table.scoreHand()
  }

  assert.ok(table.isMatchOver, 'somebody should reach 30 points inside 40 hands')
  assert.equal(table.state.phase, 'complete')
  const top = Math.max(...table.state.players.map((p) => p.totalScore))
  assert.ok(top >= 30)

  // Lowest wins: the named winner must hold the smallest total, not the largest.
  const lowest = Math.min(...table.state.players.map((p) => p.totalScore))
  const winners = table.state.players.filter((p) => p.totalScore === lowest)
  assert.equal(table.winnerName, winners.map((p) => p.name).join(' and '))
  assert.ok(
    table.winnerName !== table.state.players.find((p) => p.totalScore === top)?.name ||
      lowest === top,
    'the winner must not be the seat with the highest score'
  )
})

/* ------------------------------------------------------ forced-play rate */

test('forced plays are common enough to be worth skipping the model call for', () => {
  // CLAUDE.md guessed a quarter to a third. Measure it rather than trusting it:
  // this asserts a loose band and prints the real figure.
  const table = newTable(10_000)
  let forced = 0
  let total = 0

  for (let hand = 0; hand < 12; hand++) {
    table.startHand()
    passAnything(table)
    let guard = 0
    while (!table.handComplete && guard++ < 200) {
      const seat = table.actingPlayer!
      const legal = table.legalPlays(seat.seatIndex)
      total++
      if (legal.length === 1) forced++
      table.playCard(seat.seatIndex, legal[Math.floor(Math.random() * legal.length)])
      if (table.trickComplete) {
        table.resolveTrick()
        if (table.awaitingNextTrick) table.startNextTrick()
      }
    }
    table.scoreHand()
  }

  const rate = forced / total
  console.log(`    forced plays: ${forced}/${total} = ${(rate * 100).toFixed(1)}%`)
  assert.equal(total, 12 * 52, 'every play was counted')
  assert.ok(rate > 0.05, `forced plays should be common, saw ${(rate * 100).toFixed(1)}%`)
  assert.ok(rate < 0.6, `but not the majority of plays, saw ${(rate * 100).toFixed(1)}%`)
})

/* -------------------------------------------- trick evaluation, verified */

/**
 * Who takes a trick, worked out a different way on purpose: filter to the led
 * suit first, then take the maximum, rather than scanning with a running best.
 * Disagreement between the two means one of them is wrong.
 */
function independentWinner(plays: Array<{ seatIndex: number; card: Card }>): number {
  const ledSuit = plays[0].card.suit
  const followed = plays.filter((p) => p.card.suit === ledSuit)
  let best = followed[0]
  for (const play of followed) if (play.card.rank > best.card.rank) best = play
  return best.seatIndex
}

/** Points in a trick, counted independently of the engine's running total. */
function independentPoints(plays: Array<{ card: Card }>): number {
  let points = 0
  for (const { card } of plays) {
    if (card.suit === 'h') points += 1
    else if (card.rank === 12 && card.suit === 's') points += 13
  }
  return points
}

test('the trick winner matches an independent evaluation over a full match', () => {
  const table = newTable(10_000)
  let checked = 0

  for (let hand = 0; hand < 15; hand++) {
    table.startHand()
    passAnything(table)
    let guard = 0
    while (!table.handComplete && guard++ < 200) {
      const seat = table.actingPlayer!
      const legal = table.legalPlays(seat.seatIndex)
      table.playCard(seat.seatIndex, legal[Math.floor(Math.random() * legal.length)])
      if (table.trickComplete) {
        const before = table.state.currentTrick!.plays.map((p) => ({
          seatIndex: p.seatIndex,
          card: p.card
        }))
        const expectedWinner = independentWinner(before)
        const expectedPoints = independentPoints(before)

        const trick = table.resolveTrick()
        assert.equal(
          trick.winnerSeatIndex,
          expectedWinner,
          `trick ${trick.number}: ${before.map((p) => cardCode(p.card)).join(' ')}`
        )
        assert.equal(trick.points, expectedPoints, 'points in the trick')
        assert.equal(
          trick.winnerName,
          table.state.players[expectedWinner].name,
          'the name matches the seat'
        )
        checked++
        if (table.awaitingNextTrick) table.startNextTrick()
      }
    }
    table.scoreHand()
  }

  assert.equal(checked, 15 * 13, 'every trick of every hand was cross-checked')
})

test('the highest card of the LED suit wins, not the highest card played', () => {
  // The case that separates a correct implementation from a plausible one: an
  // ace of another suit must lose to a two of the led suit.
  const cases: Array<{ plays: Array<[number, Card]>; winner: number; points: number }> = [
    {
      // Clubs led low; an off-suit ace and king cannot take it.
      plays: [
        [0, { rank: 2, suit: 'c' }],
        [1, { rank: 14, suit: 'd' }],
        [2, { rank: 13, suit: 'h' }],
        [3, { rank: 14, suit: 's' }]
      ],
      winner: 0,
      points: 1
    },
    {
      // Ace of the led suit beats the king of it.
      plays: [
        [0, { rank: 13, suit: 's' }],
        [1, { rank: 14, suit: 's' }],
        [2, { rank: 2, suit: 's' }],
        [3, { rank: 12, suit: 's' }]
      ],
      winner: 1,
      points: 13
    },
    {
      // Nobody follows: the leader keeps it however small the card.
      plays: [
        [0, { rank: 3, suit: 'd' }],
        [1, { rank: 14, suit: 'h' }],
        [2, { rank: 13, suit: 'h' }],
        [3, { rank: 12, suit: 'c' }]
      ],
      winner: 0,
      points: 2
    },
    {
      // The queen of spades falling on someone else's trick still costs 13.
      plays: [
        [2, { rank: 9, suit: 'h' }],
        [3, { rank: 10, suit: 'h' }],
        [0, { rank: 12, suit: 's' }],
        [1, { rank: 4, suit: 'h' }]
      ],
      winner: 3,
      points: 16
    }
  ]

  for (const { plays, winner, points } of cases) {
    const table = newTable(10_000)
    table.startHand()
    const s = table.state
    s.phase = 'playing'
    s.trickNumber = 5
    s.heartsBroken = true
    s.leadSeatIndex = plays[0][0]
    s.actingSeatIndex = plays[0][0]
    s.currentTrick = { number: 5, leadSuit: plays[0][1].suit, plays: [], points: 0 }
    // Give each seat exactly the card it must play, so `legalPlays` allows it.
    for (const [seatIndex, card] of plays) s.players[seatIndex].hand = [card]

    for (const [seatIndex, card] of plays) {
      s.actingSeatIndex = seatIndex
      table.playCard(seatIndex, card)
    }
    const trick = table.resolveTrick()
    const label = plays.map(([, c]) => cardCode(c)).join(' ')
    assert.equal(trick.winnerSeatIndex, winner, `winner of ${label}`)
    assert.equal(trick.points, points, `points in ${label}`)
    assert.equal(
      independentWinner(plays.map(([seatIndex, card]) => ({ seatIndex, card }))),
      winner,
      'the fixture agrees with the independent evaluator too'
    )
  }
})

test('the trick winner leads the next trick', () => {
  const table = newTable(10_000)
  table.startHand()
  passAnything(table)

  let guard = 0
  while (!table.handComplete && guard++ < 200) {
    const seat = table.actingPlayer!
    const legal = table.legalPlays(seat.seatIndex)
    table.playCard(seat.seatIndex, legal[0])
    if (table.trickComplete) {
      const trick = table.resolveTrick()
      if (table.awaitingNextTrick) {
        table.startNextTrick()
        assert.equal(
          table.state.leadSeatIndex,
          trick.winnerSeatIndex,
          `trick ${trick.number} was taken by seat ${trick.winnerSeatIndex} but seat ` +
            `${table.state.leadSeatIndex} led the next one`
        )
        assert.equal(table.state.actingSeatIndex, trick.winnerSeatIndex)
      }
    }
  }
})

test('tricks won and points taken add up per seat across a hand', () => {
  const table = newTable(10_000)
  table.startHand()
  passAnything(table)

  const pointsBySeat = [0, 0, 0, 0]
  const tricksBySeat = [0, 0, 0, 0]
  let guard = 0
  while (!table.handComplete && guard++ < 200) {
    const seat = table.actingPlayer!
    const legal = table.legalPlays(seat.seatIndex)
    table.playCard(seat.seatIndex, legal[Math.floor(Math.random() * legal.length)])
    if (table.trickComplete) {
      const trick = table.resolveTrick()
      pointsBySeat[trick.winnerSeatIndex!] += trick.points
      tricksBySeat[trick.winnerSeatIndex!]++
      if (table.awaitingNextTrick) table.startNextTrick()
    }
  }

  for (const player of table.state.players) {
    assert.equal(player.handScore, pointsBySeat[player.seatIndex], `${player.name} hand score`)
    assert.equal(player.tricksWon, tricksBySeat[player.seatIndex], `${player.name} tricks won`)
  }
  assert.equal(pointsBySeat.reduce((a, b) => a + b, 0), POINTS_PER_HAND)
  assert.equal(tricksBySeat.reduce((a, b) => a + b, 0), CARDS_PER_HAND)
})


test('a seat holding nothing but points must break the first-trick rule', () => {
  // The one case where "no points on the first trick" cannot be honoured. It is
  // already handled — `legalPlays` falls through when no safe card exists — but
  // it is unreachable by random dealing, so the escape is pinned deliberately
  // rather than left to a one-in-ten-billion hand to exercise.
  //
  // Thirteen point cards means thirteen of the fourteen that exist (13 hearts
  // plus the queen of spades), so it can only ever befall a follower: the seat
  // on lead holds the two of clubs, which carries none.
  const table = newTable(10_000)
  table.startHand()
  const s = table.state
  s.phase = 'playing'
  s.trickNumber = 1
  s.leadSeatIndex = 0
  s.actingSeatIndex = 0
  s.currentTrick = { number: 1, leadSuit: 'c', plays: [], points: 0 }

  const allHearts: Card[] = Array.from({ length: 13 }, (_, i) => ({
    rank: (i + 2) as Card['rank'],
    suit: 'h'
  }))
  s.players[0].hand = [TWO_OF_CLUBS, { rank: 5, suit: 'd' }]
  s.players[1].hand = allHearts
  s.players[2].hand = [{ rank: 3, suit: 'c' }, { rank: 6, suit: 'd' }]
  s.players[3].hand = [{ rank: 4, suit: 'c' }, { rank: 7, suit: 'd' }]

  // The opening lead is forced and carries no points, as always.
  assert.deepEqual(table.legalPlays(0), [TWO_OF_CLUBS])
  table.playCard(0, TWO_OF_CLUBS)

  // Seat 1 is void in clubs and holds nothing but hearts. Every one of them is
  // legal — the alternative would be no legal play at all, which would wedge
  // the hand.
  const legal = table.legalPlays(1)
  assert.equal(legal.length, 13, 'every card must be playable when none is safe')
  assert.ok(legal.every((c) => cardPoints(c) > 0), 'and every one of them costs a point')

  table.playCard(1, legal[0])
  table.playCard(2, { rank: 3, suit: 'c' })
  table.playCard(3, { rank: 4, suit: 'c' })

  const trick = table.resolveTrick()
  assert.equal(trick.points, 1, 'the first trick carries a point, because it had to')
  assert.equal(
    trick.winnerSeatIndex,
    3,
    'and it goes to the highest club, not to the heart'
  )
  // Playing a heart here breaks hearts, exactly as it would on any other trick.
  assert.equal(s.heartsBroken, true)
})

test('a seat is never left without a legal play, whatever it holds', () => {
  // The invariant the case above is a corner of: if a seat has cards, it has a
  // move. Checked over every play of several full hands, since a rule that
  // filters the hand down to nothing would wedge the match rather than fail
  // loudly.
  const table = newTable(10_000)
  for (let hand = 0; hand < 6; hand++) {
    table.startHand()
    passAnything(table)
    let guard = 0
    while (!table.handComplete && guard++ < 200) {
      const seat = table.actingPlayer
      assert.ok(seat, 'somebody must be on turn')
      const legal = table.legalPlays(seat.seatIndex)
      assert.ok(
        legal.length > 0,
        `${seat.name} holds ${seat.hand.map(cardCode).join(' ')} but has no legal play`
      )
      assert.ok(
        legal.every((c) => seat.hand.some((held) => sameCard(held, c))),
        'and every legal play is a card it actually holds'
      )
      table.playCard(seat.seatIndex, legal[Math.floor(Math.random() * legal.length)])
      if (table.trickComplete) {
        table.resolveTrick()
        if (table.awaitingNextTrick) table.startNextTrick()
      }
    }
    table.scoreHand()
  }
})
