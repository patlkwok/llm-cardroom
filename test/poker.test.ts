import test from 'node:test'
import assert from 'node:assert/strict'
import { PokerTable, type PokerStep } from '../src/main/games/poker/engine.ts'
import type { PokerRules } from '../src/shared/types.ts'

const RULES: PokerRules = {
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  blindIncreaseEvery: 0
}

function seats(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `P${i}`,
    modelId: 'test/model'
  }))
}

function makeTable(n: number, rules: Partial<PokerRules> = {}): PokerTable {
  return new PokerTable(seats(n), { ...RULES, ...rules })
}

/** Total chips on the table, including whatever is in the pot. */
function totalChips(table: PokerTable): number {
  return table.state.seats.reduce((sum, s) => sum + s.stack, 0) + table.state.pot
}

test('rejects tables outside 2-8 players', () => {
  assert.throws(() => makeTable(1))
  assert.throws(() => makeTable(9))
  assert.doesNotThrow(() => makeTable(2))
  assert.doesNotThrow(() => makeTable(8))
})

test('blinds are posted and hole cards dealt', () => {
  const table = makeTable(3)
  table.startHand()
  const s = table.state
  assert.equal(s.pot, 15)
  assert.equal(s.currentBet, 10)
  for (const seat of s.seats) assert.equal(seat.cards.length, 2)

  // Every hole card is distinct.
  const codes = s.seats.flatMap((seat) => seat.cards.map((c) => `${c.rank}${c.suit}`))
  assert.equal(new Set(codes).size, codes.length)
})

test('three-handed preflop action starts under the gun and blinds are correct', () => {
  const table = makeTable(3)
  table.startHand()
  const s = table.state
  const sb = (s.buttonIndex + 1) % 3
  const bb = (s.buttonIndex + 2) % 3
  assert.equal(s.seats[sb].committed, 5, 'small blind')
  assert.equal(s.seats[bb].committed, 10, 'big blind')

  const step = table.step()
  assert.equal(step.kind, 'await')
  // Three-handed, UTG is the button.
  assert.equal((step as { seatIndex: number }).seatIndex, s.buttonIndex)
})

test('heads-up: button posts the small blind and acts first preflop', () => {
  const table = makeTable(2)
  table.startHand()
  const s = table.state
  assert.equal(s.seats[s.buttonIndex].committed, 5, 'button posts SB heads-up')

  const step = table.step()
  assert.equal(step.kind, 'await')
  assert.equal((step as { seatIndex: number }).seatIndex, s.buttonIndex)
})

test('heads-up: the non-button acts first after the flop', () => {
  const table = makeTable(2)
  table.startHand()
  const s = table.state
  const button = s.buttonIndex
  const other = (button + 1) % 2

  table.step()
  table.applyAction({ kind: 'call' })
  table.step()
  table.applyAction({ kind: 'check' }) // big blind takes the option

  const flop = table.step()
  assert.equal(flop.kind, 'street')
  assert.equal((flop as { street: string }).street, 'flop')

  const next = table.step()
  assert.equal(next.kind, 'await')
  assert.equal((next as { seatIndex: number }).seatIndex, other)
})

test('the big blind gets the option when everyone limps', () => {
  const table = makeTable(3)
  table.startHand()
  const bb = (table.state.buttonIndex + 2) % 3

  let step = table.step()
  const acted: number[] = []
  while (step.kind === 'await') {
    acted.push(step.seatIndex)
    table.applyAction({ kind: 'call' })
    step = table.step()
  }
  assert.equal(step.kind, 'street', 'the round should end with the flop')
  assert.equal(acted[acted.length - 1], bb, 'big blind acts last preflop')
  assert.equal(acted.length, 3)
})

test('a raise reopens the action for players who already acted', () => {
  const table = makeTable(3)
  table.startHand()

  const first = table.step() as { kind: 'await'; seatIndex: number }
  table.applyAction({ kind: 'call' }) // UTG limps
  const second = table.step() as { kind: 'await'; seatIndex: number }
  table.applyAction({ kind: 'raise', amount: 40 }) // SB raises

  // The limper must act again.
  let step = table.step()
  const reopened: number[] = []
  while (step.kind === 'await') {
    reopened.push(step.seatIndex)
    table.applyAction({ kind: 'fold' })
    step = table.step()
  }
  assert.ok(reopened.includes(first.seatIndex), 'the original limper acts again')
  assert.ok(second.seatIndex >= 0)
})

test('minimum raise size tracks the last full raise', () => {
  const table = makeTable(3)
  table.startHand()

  table.step()
  let legal = table.legalActions()
  assert.equal(legal.minRaiseTo, 20, 'min open raise is 2x the big blind')

  table.applyAction({ kind: 'raise', amount: 30 }) // raise of 20 over the BB
  table.step()
  legal = table.legalActions()
  assert.equal(legal.minRaiseTo, 50, 'next raise must add at least the previous increment')
})

test('folding around awards the pot to the last player standing', () => {
  const table = makeTable(4)
  table.startHand()
  const before = totalChips(table)

  let step: PokerStep = table.step()
  let payout: PokerStep | null = null
  while (step.kind !== 'handComplete') {
    if (step.kind === 'await') table.applyAction({ kind: 'fold' })
    if (step.kind === 'payout') payout = step
    step = table.step()
  }

  assert.ok(payout && payout.kind === 'payout')
  assert.equal(payout.showdown, false, 'no showdown when everyone folds')
  const total = payout.awards.reduce((sum, a) => sum + a.amount, 0)
  assert.equal(total, 15, 'the blinds are the whole pot')
  assert.equal(totalChips(table), before, 'chips are conserved')
})

test('a checked-down hand reaches showdown and pays a winner', () => {
  const table = makeTable(3)
  table.startHand()
  const before = totalChips(table)

  let step: PokerStep = table.step()
  let payout: Extract<PokerStep, { kind: 'payout' }> | null = null
  const streets: string[] = []
  while (step.kind !== 'handComplete') {
    if (step.kind === 'await') table.applyAction({ kind: 'call' })
    if (step.kind === 'street') streets.push(step.street)
    if (step.kind === 'payout') payout = step
    step = table.step()
  }

  assert.deepEqual(streets, ['flop', 'turn', 'river'])
  assert.equal(table.state.board.length, 5)
  assert.ok(payout)
  assert.equal(payout.showdown, true)
  assert.equal(
    payout.awards.reduce((sum, a) => sum + a.amount, 0),
    30,
    'everyone put in the big blind'
  )
  assert.equal(totalChips(table), before)
  for (const seat of table.state.seats) {
    assert.ok(seat.showdownHand, 'every contender shows a ranked hand')
  }
})

test('all-in for less creates a side pot the short stack cannot win', () => {
  const table = new PokerTable(seats(3), { ...RULES, startingStack: 1000 })
  // Give one player a short stack before the hand starts.
  table.state.seats[0].stack = 100
  table.startHand()
  const before = totalChips(table)

  let step: PokerStep = table.step()
  let payout: Extract<PokerStep, { kind: 'payout' }> | null = null
  while (step.kind !== 'handComplete') {
    if (step.kind === 'await') {
      const legal = table.legalActions()
      // Everyone shoves; the short stack cannot raise, so it calls all-in.
      if (legal.canRaise) table.applyAction({ kind: 'raise', amount: legal.maxRaiseTo })
      else table.applyAction({ kind: legal.canCheck ? 'check' : 'call' })
    }
    if (step.kind === 'payout') payout = step
    step = table.step()
  }

  assert.ok(payout)
  assert.equal(totalChips(table), before, 'chips are conserved with side pots')
  assert.ok(table.state.sidePots.length >= 2, 'a main pot and at least one side pot')

  const shortStack = table.state.seats[0]
  const mainPot = table.state.sidePots[0]
  assert.ok(mainPot.eligibleSeatIds.includes(shortStack.id))
  for (const pot of table.state.sidePots.slice(1)) {
    assert.ok(!pot.eligibleSeatIds.includes(shortStack.id), 'short stack is not in side pots')
  }
})

test('one seat can win both pots, but never more than it could cover', () => {
  // Winning a main pot *and* a side pot is correct play, not a bug: a seat
  // eligible for every layer that also holds the best hand takes the lot. What
  // would be a bug is a seat winning chips it could not have covered — the
  // all-in cap. From each opponent you can only win as much as you put in
  // yourself, so that cap is what this asserts.
  let sawOneSeatTakeTwoPots = false
  let sawMultiplePots = false

  for (let seed = 0; seed < 120; seed++) {
    const table = makeTable(3 + (seed % 3), { startingStack: 1000 })
    // Uneven stacks are what produce side pots once everyone gets it in.
    table.state.seats.forEach((seat, i) => {
      seat.stack = 100 * (i + 1) + (seed % 7) * 10
    })
    table.startHand()

    let step: PokerStep = table.step()
    let payout: Extract<PokerStep, { kind: 'payout' }> | null = null
    let guard = 0
    while (step.kind !== 'handComplete' && guard++ < 200) {
      if (step.kind === 'await') {
        const legal = table.legalActions()
        // Everyone gets it in; short stacks call off what they have.
        if (legal.canRaise) table.applyAction({ kind: 'raise', amount: legal.maxRaiseTo })
        else table.applyAction({ kind: legal.canCheck ? 'check' : 'call' })
      }
      if (step.kind === 'payout') payout = step
      step = table.step()
    }
    assert.ok(payout, `hand ${seed} should reach a payout`)

    const committed = new Map(table.state.seats.map((s) => [s.id, s.totalCommitted]))
    if (table.state.sidePots.length > 1) sawMultiplePots = true

    // Every award goes to a seat actually eligible for that layer.
    for (const award of payout.awards) {
      const pot = table.state.sidePots[award.potIndex]
      assert.ok(
        pot.eligibleSeatIds.includes(award.seatId),
        `${award.seatName} was paid from a pot it is not eligible for`
      )
    }

    // The all-in cap, per seat.
    for (const seat of table.state.seats) {
      if (seat.wonThisHand === 0) continue
      const mine = committed.get(seat.id) as number
      const cap = [...committed.values()].reduce((sum, theirs) => sum + Math.min(theirs, mine), 0)
      assert.ok(
        seat.wonThisHand <= cap,
        `${seat.name} won ${seat.wonThisHand} but could only cover ${cap}`
      )
    }

    // Did somebody scoop more than one layer? That is the case being asked about.
    const potsPerSeat = new Map<string, Set<number>>()
    for (const award of payout.awards) {
      const pots = potsPerSeat.get(award.seatId) ?? new Set<number>()
      pots.add(award.potIndex)
      potsPerSeat.set(award.seatId, pots)
    }
    if ([...potsPerSeat.values()].some((pots) => pots.size > 1)) sawOneSeatTakeTwoPots = true
  }

  assert.ok(sawMultiplePots, 'the scenario should produce side pots')
  assert.ok(
    sawOneSeatTakeTwoPots,
    'a seat eligible for every layer should sometimes win them all — that is the rule'
  )
})

test('chips are conserved across many randomised hands', () => {
  for (let seed = 0; seed < 60; seed++) {
    const playerCount = 2 + (seed % 7)
    const table = makeTable(playerCount)
    const expected = playerCount * RULES.startingStack

    for (let handNo = 0; handNo < 12 && !table.isMatchOver; handNo++) {
      table.startHand()
      let step: PokerStep = table.step()
      let guard = 0
      while (step.kind !== 'handComplete') {
        if (++guard > 5000) throw new Error('engine failed to terminate')
        if (step.kind === 'await') {
          const legal = table.legalActions()
          const roll = Math.random()
          if (roll < 0.18 && legal.canFold && !legal.canCheck) {
            table.applyAction({ kind: 'fold' })
          } else if (roll < 0.82) {
            table.applyAction({ kind: legal.canCheck ? 'check' : 'call' })
          } else if (legal.canRaise) {
            const span = legal.maxRaiseTo - legal.minRaiseTo
            const amount = legal.minRaiseTo + Math.floor(Math.random() * (span + 1))
            table.applyAction({ kind: 'raise', amount })
          } else {
            table.applyAction({ kind: legal.canCheck ? 'check' : 'call' })
          }
        }
        step = table.step()
      }
      assert.equal(totalChips(table), expected, `chip leak in hand ${handNo}`)
      for (const seat of table.state.seats) {
        assert.ok(seat.stack >= 0, 'no negative stacks')
      }
    }
  }
})

test('a player who loses every chip is marked busted and skipped', () => {
  const table = makeTable(3)
  table.state.seats[1].stack = 20
  let guard = 0
  while (!table.isMatchOver && guard++ < 200) {
    table.startHand()
    let step: PokerStep = table.step()
    while (step.kind !== 'handComplete') {
      if (step.kind === 'await') {
        const legal = table.legalActions()
        if (legal.canRaise) table.applyAction({ kind: 'raise', amount: legal.maxRaiseTo })
        else table.applyAction({ kind: legal.canCheck ? 'check' : 'call' })
      }
      step = table.step()
    }
    for (const seat of table.state.seats) {
      if (seat.busted) assert.equal(seat.stack, 0)
    }
  }
  assert.ok(table.isMatchOver, 'the match eventually ends')
  assert.ok(table.winnerName, 'one player holds all the chips')
})

/* --------------------------------------------------- roster changes */

function playHandOut(table: PokerTable): void {
  table.startHand()
  let step: PokerStep = table.step()
  let guard = 0
  while (step.kind !== 'handComplete') {
    if (guard++ > 2000) throw new Error('hand did not terminate')
    if (step.kind === 'await') {
      const legal = table.legalActions()
      table.applyAction({ kind: legal.canCheck ? 'check' : 'call' })
    }
    step = table.step()
  }
}

test('a seat added between hands buys in and is dealt in next hand', () => {
  const table = makeTable(3)
  playHandOut(table)
  const chipsBefore = totalChips(table)

  table.addSeat({ id: 'new', name: 'Newcomer', modelId: 'test/model' }, 500)
  assert.equal(table.state.seats.length, 4)
  assert.equal(totalChips(table), chipsBefore + 500, 'the buy-in is new money')

  playHandOut(table)
  const newcomer = table.state.seats.find((s) => s.id === 'new')
  assert.ok(newcomer)
  assert.equal(newcomer.cards.length, 2, 'dealt in on the next hand')
  assert.equal(newcomer.seatIndex, 3)
})

test('the table refuses a ninth seat', () => {
  const table = makeTable(8)
  assert.throws(
    () => table.addSeat({ id: 'x', name: 'X', modelId: 'test/model' }, 500),
    /full at 8 seats/
  )
})

test('adding a seat that is already present is a no-op', () => {
  const table = makeTable(3)
  table.addSeat({ id: 'p1', name: 'P1', modelId: 'test/model' }, 500)
  assert.equal(table.state.seats.length, 3)
})

test('a removed seat takes its chips and the rest keep playing', () => {
  const table = makeTable(4)
  playHandOut(table)
  const victim = table.state.seats[1]
  const victimChips = victim.stack
  const chipsBefore = totalChips(table)

  assert.equal(table.removeSeat(victim.id), true)
  assert.equal(table.state.seats.length, 3)
  assert.equal(totalChips(table), chipsBefore - victimChips, 'their chips leave with them')
  assert.ok(!table.state.seats.some((s) => s.id === victim.id))

  // Seat indices must stay positional or the button maths breaks.
  table.state.seats.forEach((seat, i) => assert.equal(seat.seatIndex, i))

  playHandOut(table)
  assert.equal(table.state.seats.length, 3)
  for (const seat of table.state.seats) assert.equal(seat.cards.length, 2)
})

test('removing an unknown seat reports that nothing changed', () => {
  const table = makeTable(3)
  assert.equal(table.removeSeat('nobody'), false)
  assert.equal(table.state.seats.length, 3)
})

test('the button stays on the same player when someone ahead of it leaves', () => {
  const table = makeTable(4)
  playHandOut(table)
  const buttonId = table.state.seats[table.state.buttonIndex].id
  const ahead = table.state.seats.find((s) => s.seatIndex < table.state.buttonIndex)

  if (ahead) {
    table.removeSeat(ahead.id)
    assert.equal(
      table.state.seats[table.state.buttonIndex].id,
      buttonId,
      'the button still points at the same player'
    )
  }
  assert.ok(table.state.buttonIndex < table.state.seats.length)
})

test('blinds are still posted correctly after seats change', () => {
  const table = makeTable(5)
  playHandOut(table)
  table.removeSeat(table.state.seats[0].id)
  table.addSeat({ id: 'late', name: 'Late', modelId: 'test/model' }, 400)

  const expected = totalChips(table)
  table.startHand()
  assert.equal(table.state.pot, RULES.smallBlind + RULES.bigBlind)
  assert.equal(totalChips(table), expected, 'chips are conserved through the change')
  for (const seat of table.state.seats) assert.equal(seat.cards.length, 2)
})

test('chips are conserved across repeated roster churn', () => {
  const table = makeTable(4)
  let expected = totalChips(table)
  let nextId = 0

  for (let round = 0; round < 25; round++) {
    playHandOut(table)
    assert.equal(totalChips(table), expected, `chip leak at round ${round}`)

    const live = table.state.seats.filter((s) => !s.busted)
    if (round % 2 === 0 && table.state.seats.length < 8) {
      table.addSeat({ id: `add${nextId++}`, name: `Add${nextId}`, modelId: 'test/model' }, 300)
      expected += 300
    } else if (live.length > 2) {
      const leaving = table.state.seats[table.state.seats.length - 1]
      expected -= leaving.stack
      table.removeSeat(leaving.id)
    }
    assert.equal(totalChips(table), expected, `chip leak after churn at round ${round}`)
  }
})

test('raise amounts are clamped into the legal band', () => {
  const table = makeTable(3)
  table.startHand()
  table.step()
  const legal = table.legalActions()

  // Far too small: clamps up to the minimum.
  table.applyAction({ kind: 'raise', amount: 1 })
  assert.equal(table.state.currentBet, legal.minRaiseTo)

  table.step()
  const legal2 = table.legalActions()
  // Far too large: clamps down to an all-in.
  table.applyAction({ kind: 'raise', amount: 999_999 })
  assert.equal(table.state.currentBet, legal2.maxRaiseTo)
})

/* ------------------------------------------------ betting-rule regressions */

test('an undersized all-in still requires the others to call', () => {
  const table = makeTable(3)
  // Seat 2 can shove 140 over a raise to 100: an increment of 40 against a
  // minimum of 90, so it does not reopen raising.
  table.state.seats[2].stack = 140
  table.startHand()

  const asked: string[] = []
  let cappedSawRaise = false
  for (let guard = 0; guard < 40; guard++) {
    const step = table.step()
    if (step.kind !== 'await') break
    const seat = table.state.seats[step.seatIndex]
    asked.push(seat.id)

    if (seat.id === 'p1' && seat.totalCommitted < 100) {
      table.applyAction({ kind: 'raise', amount: 100 })
    } else if (seat.id === 'p2') {
      table.applyAction({ kind: 'raise', amount: 140 })
    } else if (seat.id === 'p1') {
      // p1 is facing the undersized all-in: must call or fold, may not raise.
      if (table.legalActions().canRaise) cappedSawRaise = true
      table.applyAction({ kind: 'call' })
    } else {
      table.applyAction({ kind: 'fold' })
    }
  }

  const p1 = table.state.seats[1]
  const p2 = table.state.seats[2]
  assert.equal(asked.filter((id) => id === 'p1').length, 2, 'the raiser must act again')
  assert.equal(p1.totalCommitted, p2.totalCommitted, 'and must match the all-in to stay in')
  assert.equal(cappedSawRaise, false, 'an undersized all-in must not reopen raising')
})

test('a short big blind does not lower the price for everyone else', () => {
  const table = makeTable(3)
  table.state.seats[0].stack = 8 // seat 0 is the big blind in the first hand
  table.startHand()

  assert.equal(table.state.seats[0].committed, 8, 'posts only what it has')
  assert.equal(table.state.currentBet, table.state.bigBlind, 'but the bet level is the full blind')

  const step = table.step()
  assert.equal(step.kind, 'await')
  assert.equal(table.legalActions().callAmount, table.state.bigBlind)
})

test('removing the button holder does not skip the next player', () => {
  for (let button = 0; button < 3; button++) {
    const table = makeTable(3)
    table.state.buttonIndex = button
    const dueNext = table.state.seats[(button + 1) % 3].id

    table.removeSeat(table.state.seats[button].id)

    const seats = table.state.seats
    const next = seats[(table.state.buttonIndex + 1) % seats.length]
    assert.equal(next.id, dueNext, `button at ${button}: ${dueNext} was due the button next`)
  }
})

test('the whole pot reaches a winner when everyone folds to a raise', () => {
  const table = makeTable(3)
  const before = totalChips(table)
  table.startHand()

  for (let guard = 0; guard < 20; guard++) {
    const step = table.step()
    if (step.kind !== 'await') break
    const seat = table.state.seats[step.seatIndex]
    if (seat.id === 'p1' && seat.totalCommitted < 200 && table.legalActions().canRaise) {
      table.applyAction({ kind: 'raise', amount: 200 })
    } else {
      table.applyAction({ kind: 'fold' })
    }
  }
  while (table.step().kind !== 'handComplete') { /* drain */ }

  assert.equal(totalChips(table), before, 'no chips may be created or destroyed')
  assert.equal(table.state.seats[1].stack, 1015, 'the raiser gets its bet back plus the blinds')
})

test('chips survive players who fold when checking was free', () => {
  // The other conservation test never folds for free, which is exactly the line
  // that can strand a pot layer with nobody eligible for it. Fold aggressively
  // here, including when there is nothing to call.
  // Fresh tables so the run keeps covering multi-way pots instead of collapsing
  // to a heads-up match after the first few bust-outs.
  let hands = 0
  for (let round = 0; round < 60; round++) {
    const table = makeTable(4, { startingStack: 400 })
    const before = totalChips(table)

    for (let hand = 0; hand < 40 && !table.isMatchOver; hand++) {
      table.startHand()
      for (let guard = 0; guard < 200; guard++) {
        const step = table.step()
        if (step.kind === 'handComplete') break
        if (step.kind !== 'await') continue

        const legal = table.legalActions()
        const roll = Math.random()
        if (roll < 0.25) {
          table.applyAction({ kind: 'fold' })
        } else if (legal.canRaise && roll < 0.45) {
          const span = legal.maxRaiseTo - legal.minRaiseTo
          table.applyAction({ kind: 'raise', amount: legal.minRaiseTo + Math.floor(Math.random() * (span + 1)) })
        } else if (legal.canCheck) {
          table.applyAction({ kind: 'check' })
        } else {
          table.applyAction({ kind: 'call' })
        }
      }
      hands++
      assert.equal(totalChips(table), before, `chips changed in table ${round + 1} hand ${hand + 1}`)
      assert.equal(table.state.pot, 0, `pot not fully awarded in table ${round + 1} hand ${hand + 1}`)
    }
  }
  assert.ok(hands > 400, `expected a meaningful sample, played ${hands} hands`)
})
