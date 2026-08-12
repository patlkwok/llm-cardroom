import test from 'node:test'
import assert from 'node:assert/strict'
import { handEquity } from '../src/main/games/poker/equity.ts'
import { PokerTable } from '../src/main/games/poker/engine.ts'
import { buildPokerPrompt } from '../src/main/games/prompts.ts'
import type { Card, Rank, Suit } from '../src/shared/cards.ts'
import type { PokerRules } from '../src/shared/types.ts'

function cards(text: string): Card[] {
  if (!text.trim()) return []
  const rankMap: Record<string, number> = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    T: 10, J: 11, Q: 12, K: 13, A: 14
  }
  return text.trim().split(/\s+/).map((code) => ({
    rank: rankMap[code[0].toUpperCase()] as Rank,
    suit: code[1].toLowerCase() as Suit
  }))
}

const RULES: PokerRules = {
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  blindIncreaseEvery: 0
}

test('exact cases need no sampling at all', () => {
  // Board plays: both players use all five community cards.
  const tie = handEquity([cards('2c 3d'), cards('2h 3s')], cards('As Ks Qh Jd Tc'))
  assert.deepEqual(tie, [0.5, 0.5])

  // Already decided on the river.
  const done = handEquity([cards('As Ah'), cards('Ks Kh')], cards('2c 7d 9h Ad 3s'))
  assert.deepEqual(done, [1, 0])
})

test('shares always sum to one', () => {
  const boards = ['', '2c 7d 9h', '2c 7d 9h Ts', '2c 7d 9h Ts 4d']
  for (const board of boards) {
    const shares = handEquity(
      [cards('As Ah'), cards('Ks Kh'), cards('Qs Qh')],
      cards(board)
    )
    const total = shares.reduce((sum, s) => sum + s, 0)
    assert.ok(Math.abs(total - 1) < 1e-9, `board "${board}" summed to ${total}`)
  }
})

test('known matchups land where poker literature puts them', () => {
  // Sampled preflop, so allow a couple of points of slack.
  const [aces] = handEquity([cards('As Ah'), cards('Ks Kh')], [])
  assert.ok(aces > 0.79 && aces < 0.86, `AA vs KK came out ${aces}`)

  const [ak] = handEquity([cards('As Kh'), cards('7d 2c')], [])
  assert.ok(ak > 0.64 && ak < 0.72, `AKo vs 72o came out ${ak}`)

  // Exact from the flop: aces are a huge favourite on a dry board.
  const [ahead] = handEquity([cards('As Ah'), cards('Ks Kh')], cards('2c 7d 9h'))
  assert.ok(ahead > 0.88 && ahead < 0.94, `AA vs KK on the flop came out ${ahead}`)
})

test('folded hole cards are removed from the deck, not dealt again', () => {
  // The case turns on the last ace: if the folded hand is ignored, the runout
  // can deal a card that is provably gone.
  const withoutDead = handEquity([cards('Ks Kh'), cards('Qs Qh')], cards('2c 7d 9h'))
  const withDead = handEquity([cards('Ks Kh'), cards('Qs Qh')], cards('2c 7d 9h'), {
    dead: cards('Kd Kc')
  })
  assert.notDeepEqual(withoutDead, withDead, 'dead cards must change the result')
})

test('the engine gives every contender a share and folded seats none', () => {
  const table = new PokerTable(
    [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}`, modelId: 'test/model' })),
    RULES
  )
  table.startHand()
  table.refreshEquity()

  const total = table.state.seats.reduce((sum, s) => sum + (s.equity ?? 0), 0)
  assert.ok(Math.abs(total - 1) < 1e-9, `equity summed to ${total}`)

  // Fold one seat; it loses its share and the rest still add up.
  table.state.seats[0].folded = true
  table.refreshEquity()
  assert.equal(table.state.seats[0].equity, undefined)
  const after = table.state.seats.reduce((sum, s) => sum + (s.equity ?? 0), 0)
  assert.ok(Math.abs(after - 1) < 1e-9, `equity summed to ${after} after a fold`)
})

test('equity never reaches a prompt', () => {
  const table = new PokerTable(
    [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}`, modelId: 'test/model' })),
    RULES
  )
  table.startHand()

  const step = table.step()
  assert.equal(step.kind, 'await')
  const seatIndex = (step as { kind: 'await'; seatIndex: number }).seatIndex

  const render = (): string => {
    const prompt = buildPokerPrompt(table, seatIndex, table.legalActions(), [], RULES)
    return `${prompt.system}\n${prompt.user}`
  }

  // Equity is computed from every player's hole cards, so a prompt that changed
  // once it existed would be handing the acting model information about its
  // opponents. Comparing before against after beats grepping for numbers: the
  // prompt legitimately quotes a pot-odds percentage, and any substring check
  // would collide with it sooner or later.
  const before = render()
  assert.ok(table.state.seats.every((s) => s.equity === undefined))

  table.refreshEquity()
  assert.ok(table.state.seats.some((s) => s.equity !== undefined), 'equity should exist by now')

  assert.equal(render(), before, 'the prompt changed once equity was known')
})
