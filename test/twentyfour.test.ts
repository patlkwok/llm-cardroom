import test from 'node:test'
import assert from 'node:assert/strict'
import {
  equals,
  formatFrac,
  frac,
  parseExpression,
  TARGET,
  validateExpression
} from '../src/main/games/twentyfour/expression.ts'
import { isSolvable, solve } from '../src/main/games/twentyfour/solver.ts'
import {
  median,
  puzzleValue,
  TwentyFourTable,
  type TwentyFourAnswer
} from '../src/main/games/twentyfour/engine.ts'
import { parseTwentyFourReply } from '../src/main/games/prompts/twentyfour.ts'
import { DEFAULT_TWENTYFOUR_RULES } from '../src/shared/types.ts'

const SEEDS = ['a', 'b', 'c'].map((id, i) => ({ id, name: `Bot${i}`, modelId: 'test/model' }))

function newTable(targetScore = DEFAULT_TWENTYFOUR_RULES.targetScore): TwentyFourTable {
  return new TwentyFourTable(SEEDS, { targetScore })
}

/* --------------------------------------------------- exact arithmetic */

test('the classic float trap evaluates to exactly 24', () => {
  // 8/(3-8/3) is 24 exactly, and is NOT 24 in floating point. This is the whole
  // reason the evaluator works in rationals.
  const check = validateExpression('8/(3-8/3)', [8, 3, 8, 3])
  assert.equal(check.ok, true, check.problem ?? '')
  assert.ok(check.value)
  assert.ok(equals(check.value, TARGET), `got ${formatFrac(check.value)}`)

  // And to show the trap is real rather than theoretical:
  assert.notEqual(8 / (3 - 8 / 3), 24, 'floating point does not get this right')
})

test('other known exact-division solutions evaluate correctly', () => {
  const cases: Array<[string, number[]]> = [
    ['(1 + 5) * (5 - 1)', [1, 5, 5, 1]],
    ['(3 - 2/2) * 12', [3, 2, 2, 12]],
    ['(5 - 1/5) * 5', [5, 1, 5, 5]],
    ['6/(1-3/4)', [6, 1, 3, 4]],
    ['(13 - 1) * (3 - 1)', [13, 1, 3, 1]]
  ]
  for (const [expression, values] of cases) {
    const check = validateExpression(expression, values)
    assert.equal(check.ok, true, `${expression}: ${check.problem ?? ''}`)
    assert.ok(check.value && equals(check.value, TARGET), `${expression} did not make 24`)
  }
})

test('fractions are reported exactly rather than rounded', () => {
  const check = validateExpression('(9 + 5) * 5 / 3', [9, 5, 5, 3])
  assert.equal(check.ok, true, check.problem ?? '')
  assert.equal(formatFrac(check.value!), '70/3')
})

test('frac normalises sign and reduces to lowest terms', () => {
  assert.deepEqual(frac(6, -8), { n: -3, d: 4 })
  assert.deepEqual(frac(0, 5), { n: 0, d: 1 })
  assert.throws(() => frac(1, 0), RangeError)
})

/* ---------------------------------------------------------- the parser */

test('the parser rejects anything that is not arithmetic', () => {
  // The string comes from a language model, so this must never be eval'd and
  // must never accept anything it cannot itself evaluate.
  const rubbish = [
    'process.exit(1)',
    'require("fs")',
    '2 ** 8',
    '8!',
    'alert(24)',
    '24; drop table',
    '4.5 * 6',
    'twenty four',
    '((6*4)',
    '6 * * 4',
    '',
    '+',
    '6 4'
  ]
  for (const text of rubbish) {
    const parsed = parseExpression(text)
    assert.equal(parsed.ok, false, `"${text}" should not parse`)
    assert.ok(parsed.problem, `"${text}" should explain itself`)
  }
})

test('division by zero is rejected rather than producing Infinity', () => {
  const check = validateExpression('24/(3-3)*2', [24, 3, 3, 2])
  assert.equal(check.ok, false)
  assert.match(check.problem ?? '', /divides by zero/)
})

test('unary minus is accepted and does not disturb the card count', () => {
  const check = validateExpression('-6 * -4 * 1 * 1', [6, 4, 1, 1])
  assert.equal(check.ok, true, check.problem ?? '')
  assert.ok(equals(check.value!, TARGET))
})

test('the four cards must be used as a multiset, each exactly once', () => {
  // Duplicates are legal, so [8,8,3,3] must accept an answer using both eights
  // and reject one that uses a single eight twice.
  const good = validateExpression('8/(3-8/3)', [8, 8, 3, 3])
  assert.equal(good.ok, true, good.problem ?? '')

  // Uses 8 twice and 3 twice — which happens to be the same multiset, so it is
  // legal. The illegal case is using a value more often than it was dealt:
  const reused = validateExpression('8*3*(8/8)', [8, 3, 3, 1])
  assert.equal(reused.ok, false, 'three 8s were dealt only one 8')
  assert.match(reused.problem ?? '', /exactly once/)

  const missing = validateExpression('6 * 4', [6, 4, 1, 1])
  assert.equal(missing.ok, false, 'leaving cards out is not allowed')

  const extra = validateExpression('6 * 4 * 1 * 1 * 1', [6, 4, 1, 1])
  assert.equal(extra.ok, false, 'inventing an extra card is not allowed')
})

/* ---------------------------------------------------------- the solver */

test('the solver agrees with an independent brute-force oracle', () => {
  // A second implementation, written differently on purpose: this one
  // enumerates operator triples over permutations and the five bracketings,
  // rather than repeatedly collapsing pairs.
  const ops = ['+', '-', '*', '/'] as const
  const apply = (a: number | null, b: number | null, op: string): number | null => {
    if (a === null || b === null) return null
    if (op === '+') return a + b
    if (op === '-') return a - b
    if (op === '*') return a * b
    return b === 0 ? null : a / b
  }
  const permutations = (xs: number[]): number[][] =>
    xs.length <= 1
      ? [xs]
      : xs.flatMap((x, i) =>
          permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])
        )

  const oracle = (values: number[]): boolean => {
    for (const [a, b, c, d] of permutations(values)) {
      for (const o1 of ops) for (const o2 of ops) for (const o3 of ops) {
        const shapes = [
          apply(apply(apply(a, b, o1), c, o2), d, o3),
          apply(apply(a, b, o1), apply(c, d, o3), o2),
          apply(a, apply(apply(b, c, o2), d, o3), o1),
          apply(a, apply(b, apply(c, d, o3), o2), o1),
          apply(apply(a, apply(b, c, o2), o1), d, o3)
        ]
        if (shapes.some((v) => v !== null && Math.abs(v - 24) < 1e-6)) return true
      }
    }
    return false
  }

  let checked = 0
  for (let a = 1; a <= 13; a++) {
    for (let b = a; b <= 13; b++) {
      for (let c = b; c <= 13; c++) {
        for (let d = c; d <= 13; d += 3) {
          const values = [a, b, c, d]
          assert.equal(
            isSolvable(values),
            oracle(values),
            `solver and oracle disagree on ${values.join(',')}`
          )
          checked++
        }
      }
    }
  }
  assert.ok(checked > 400, `should have checked a decent sample, saw ${checked}`)
})

test('every solution the solver returns actually validates', () => {
  for (let attempt = 0; attempt < 300; attempt++) {
    const values = Array.from({ length: 4 }, () => 1 + Math.floor(Math.random() * 13))
    const solution = solve(values)
    if (!solution) continue
    const check = validateExpression(solution, values)
    assert.equal(check.ok, true, `${solution} for ${values.join(',')}: ${check.problem ?? ''}`)
    assert.ok(
      equals(check.value!, TARGET),
      `${solution} for ${values.join(',')} came to ${formatFrac(check.value!)}`
    )
  }
})

test('the solvable share of four-card deals is measured, not assumed', () => {
  // The notes guessed "roughly three quarters" and said to measure it. This is
  // the measurement, over every multiset from 1..13.
  let total = 0
  let solvable = 0
  for (let a = 1; a <= 13; a++) {
    for (let b = a; b <= 13; b++) {
      for (let c = b; c <= 13; c++) {
        for (let d = c; d <= 13; d++) {
          total++
          if (isSolvable([a, b, c, d])) solvable++
        }
      }
    }
  }
  const rate = solvable / total
  console.log(`    solvable multisets: ${solvable}/${total} = ${(rate * 100).toFixed(1)}%`)
  assert.equal(total, 1820, 'C(16,4) multisets of four values from 1..13')
  assert.ok(rate > 0.6 && rate < 0.9, `solvable share looks wrong: ${(rate * 100).toFixed(1)}%`)
})

/* ------------------------------------------------------------ the race */

test('the round is decided from the injected answers alone, never a clock', () => {
  const table = newTable(0)
  table.startRound()
  // Force a known-solvable deal so the grading is deterministic.
  table.state.cards = [
    { rank: 6, suit: 'c' },
    { rank: 4, suit: 'd' },
    { rank: 3, suit: 'h' },
    { rank: 2, suit: 's' }
  ]
  table.state.solution = solve(table.values)
  table.state.solvable = true

  const answers: TwentyFourAnswer[] = [
    { playerId: 'a', expression: '6 * 4 * (3 - 2)', elapsedMs: 3000 },
    { playerId: 'b', expression: '6 * 4 * (3 - 2)', elapsedMs: 1200 },
    { playerId: 'c', expression: '6 + 4 + 3 + 2', elapsedMs: 100 }
  ]
  table.settleRound(answers)

  const byId = new Map(table.state.results.map((r) => [r.playerId, r]))
  assert.equal(byId.get('b')?.won, true, 'the fastest correct answer takes the round')
  assert.equal(byId.get('b')?.rank, 1)
  assert.equal(byId.get('a')?.rank, 2)
  // A fast wrong answer must not beat a slow correct one.
  assert.equal(byId.get('c')?.won, false, 'answering fastest is not the same as answering right')
  assert.equal(byId.get('c')?.verdict, 'wrong')
  assert.equal(byId.get('c')?.rank, 0)
  assert.equal(byId.get('c')?.valueLabel, '15')

  assert.equal(table.player('b')?.score, 1)
  assert.equal(table.player('a')?.score, 0, 'being correct but slower wins no round')
  assert.equal(table.player('a')?.solved, 1, 'but it still counts as solved')
})

test('the same answers always produce the same winner', () => {
  const answers: TwentyFourAnswer[] = [
    { playerId: 'a', expression: '6 * 4 * (3 - 2)', elapsedMs: 900 },
    { playerId: 'b', expression: '6 * 4 * (3 - 2)', elapsedMs: 900 },
    { playerId: 'c', expression: 'none', elapsedMs: 50 }
  ]
  const winners = new Set<string>()
  for (let run = 0; run < 5; run++) {
    const table = newTable(0)
    table.startRound()
    table.state.cards = [
      { rank: 6, suit: 'c' },
      { rank: 4, suit: 'd' },
      { rank: 3, suit: 'h' },
      { rank: 2, suit: 's' }
    ]
    table.state.solution = solve(table.values)
    table.state.solvable = true
    // Shuffled input order must not change the outcome.
    table.settleRound([...answers].sort(() => Math.random() - 0.5))
    winners.add(table.state.results.find((r) => r.won)?.playerId ?? 'nobody')
  }
  // An exact tie breaks on seat order, so it is reproducible rather than
  // dependent on which promise happened to be first in the array.
  assert.equal(winners.size, 1, `a tie should resolve the same way every time, saw ${[...winners]}`)
  assert.deepEqual([...winners], ['a'])
})

test('"no solution" is correct on an unsolvable deal and wrong on a solvable one', () => {
  // 1,1,1,1 cannot make 24; 6,4,3,2 plainly can.
  const unsolvable = newTable(0)
  unsolvable.startRound()
  unsolvable.state.cards = [
    { rank: 14, suit: 'c' },
    { rank: 14, suit: 'd' },
    { rank: 14, suit: 'h' },
    { rank: 14, suit: 's' }
  ]
  assert.deepEqual(unsolvable.values, [1, 1, 1, 1], 'aces are 1')
  unsolvable.state.solution = solve(unsolvable.values)
  unsolvable.state.solvable = unsolvable.state.solution !== null
  assert.equal(unsolvable.state.solvable, false)

  unsolvable.settleRound([
    { playerId: 'a', expression: null, elapsedMs: 500 },
    { playerId: 'b', expression: '1 * 1 * 1 * 24', elapsedMs: 100 },
    { playerId: 'c', expression: '1 + 1 + 1 + 1', elapsedMs: 200 }
  ])
  const byId = new Map(unsolvable.state.results.map((r) => [r.playerId, r]))
  assert.equal(byId.get('a')?.verdict, 'correct', 'spotting an impossible deal is a correct answer')
  assert.equal(byId.get('a')?.won, true)
  // Bluffing an expression that uses a card it was never dealt is invalid, and
  // catching exactly this is why unsolvable deals are dealt on purpose.
  assert.equal(byId.get('b')?.verdict, 'invalid')
  assert.equal(byId.get('c')?.verdict, 'wrong')

  const solvable = newTable(0)
  solvable.startRound()
  solvable.state.cards = [
    { rank: 6, suit: 'c' },
    { rank: 4, suit: 'd' },
    { rank: 3, suit: 'h' },
    { rank: 2, suit: 's' }
  ]
  solvable.state.solution = solve(solvable.values)
  solvable.state.solvable = true
  solvable.settleRound([{ playerId: 'a', expression: null, elapsedMs: 10 }])
  const claim = solvable.state.results.find((r) => r.playerId === 'a')
  assert.equal(claim?.verdict, 'wrong', 'claiming no solution when there is one is wrong')
  assert.match(claim?.problem ?? '', /There is a solution/)
})

test('a model that never answered is recorded as such, not as wrong', () => {
  const table = newTable(0)
  table.startRound()
  table.settleRound([{ playerId: 'a', expression: 'none', elapsedMs: 100 }])

  const byId = new Map(table.state.results.map((r) => [r.playerId, r]))
  assert.equal(byId.get('b')?.verdict, 'none')
  assert.equal(byId.get('c')?.verdict, 'none')
  assert.equal(table.player('b')?.wrong, 0, 'silence is not a wrong answer')
  assert.equal(table.player('b')?.latencies.length, 0, 'and contributes no latency')
})

test('the match ends when a model reaches the target score', () => {
  const table = newTable(2)
  for (let round = 0; round < 5 && !table.isMatchOver; round++) {
    table.startRound()
    table.state.cards = [
      { rank: 6, suit: 'c' },
      { rank: 4, suit: 'd' },
      { rank: 3, suit: 'h' },
      { rank: 2, suit: 's' }
    ]
    table.state.solution = solve(table.values)
    table.state.solvable = true
    table.settleRound([{ playerId: 'a', expression: '6 * 4 * (3 - 2)', elapsedMs: 100 }])
  }
  assert.equal(table.isMatchOver, true)
  assert.equal(table.state.phase, 'complete')
  assert.equal(table.player('a')?.score, 2)
  assert.equal(table.winnerName, 'Bot0')
})

test('a deal is never filtered for solvability', () => {
  // Dealing unsolvable hands on purpose is the design decision that makes
  // "no solution" a real answer. Over enough deals, some must be impossible.
  const table = newTable(0)
  let unsolvable = 0
  for (let round = 0; round < 400; round++) {
    table.startRound()
    if (!table.state.solvable) unsolvable++
    assert.equal(table.state.cards.length, 4)
    assert.equal(
      table.state.solvable,
      table.state.solution !== null,
      'solvable and solution must agree'
    )
  }
  assert.ok(unsolvable > 0, 'some deals should be impossible; they are not being filtered out')
})

/* ---------------------------------------------------------- reply shape */

test('the reply parser reads expressions and no-solution claims alike', () => {
  const cases: Array<[string, string | null]> = [
    ['{"reasoning":"r","expression":"(6*4)*(3-2)"}', '(6*4)*(3-2)'],
    ['{"reasoning":"r","expression":"6*4 = 24"}', '6*4'],
    ['{"reasoning":"r","expression":"none"}', null],
    ['{"reasoning":"r","expression":"None."}', null],
    ['{"reasoning":"r","expression":"no solution"}', null],
    ['{"reasoning":"r","expression":"impossible"}', null],
    ['{"reasoning":"r","answer":"8/(3-8/3)"}', '8/(3-8/3)'],
    ['```json\n{"reasoning":"r","expression":"1+2+3+18"}\n```', '1+2+3+18']
  ]
  for (const [reply, expected] of cases) {
    const outcome = parseTwentyFourReply(reply)
    assert.equal(outcome.ok, true, `${reply} should parse`)
    assert.equal(outcome.value, expected, `for ${reply}`)
  }

  for (const bad of ['not json at all', '{"reasoning":"r"}', '{"expression":""}']) {
    assert.equal(parseTwentyFourReply(bad).ok, false, `${bad} should be rejected`)
  }
})

test('a wrong expression is accepted by the parser and judged by the engine', () => {
  // Deliberate: `agent.ts` retries whatever the parser rejects, so rejecting bad
  // arithmetic here would give one model three attempts at the puzzle while
  // another got one.
  const outcome = parseTwentyFourReply('{"reasoning":"r","expression":"1+1"}')
  assert.equal(outcome.ok, true, 'the parser judges shape, not arithmetic')
  assert.equal(outcome.value, '1+1')
})

/* -------------------------------------------------------------- helpers */

test('puzzleValue maps aces to 1 and faces to 11, 12, 13', () => {
  assert.equal(puzzleValue({ rank: 14, suit: 's' }), 1)
  assert.equal(puzzleValue({ rank: 11, suit: 's' }), 11)
  assert.equal(puzzleValue({ rank: 12, suit: 's' }), 12)
  assert.equal(puzzleValue({ rank: 13, suit: 's' }), 13)
  assert.equal(puzzleValue({ rank: 7, suit: 's' }), 7)
})

test('median reports the middle answering time', () => {
  assert.equal(median([]), 0)
  assert.equal(median([5]), 5)
  assert.equal(median([9, 1, 5]), 5)
  assert.equal(median([1, 2, 3, 4]), 3)
})
