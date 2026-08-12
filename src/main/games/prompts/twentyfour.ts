import { cardCode, cardName, type Card } from '../../../shared/cards.ts'
import type { TwentyFourPlayer, TwentyFourRules, TwentyFourState } from '../../../shared/types.ts'
import { puzzleValue } from '../twentyfour/engine.ts'
import { extractJson, notJson, readReasoning, type ParseOutcome, type Prompt } from './shared.ts'

/**
 * The rules, stated in force. The face-card values and the exactness of the
 * division are both variant decisions, and "no solution" being a legal answer
 * is the whole point of the game — a model that assumes every deal is solvable
 * will bluff an expression rather than say so.
 */
export function twentyFourSystemPrompt(_rules: TwentyFourRules): string {
  return [
    'You are playing the card game 24 against other AI players. Everyone is shown the same',
    'four cards at the same moment, and the first correct answer wins the round.',
    '',
    'Rules in force:',
    '- Combine ALL FOUR numbers to make exactly 24.',
    '- Card values: **ace = 1, jack = 11, queen = 12, king = 13.** Number cards are face value.',
    '- Use each of the four numbers EXACTLY ONCE. You may not reuse one or leave one out.',
    '- Allowed operations: + - * / and brackets. Nothing else: no exponents, no',
    '  concatenating digits, no factorials, no decimal points.',
    '- Division is exact, not rounded and not integer division. 8/(3-8/3) = 24 is valid.',
    '- Intermediate results may be fractions or negative; only the final value must be 24.',
    '',
    '**Not every deal can be made into 24.** Unsolvable hands are dealt on purpose.',
    'If there is genuinely no way, say so — that is a correct answer and it scores.',
    'Guessing an expression that does not actually evaluate to 24 scores nothing, so check',
    'your arithmetic before answering rather than submitting something that looks close.',
    '',
    'HOW TO ANSWER',
    'Reply with the expression on its own, and nothing else at all:',
    '',
    '    (6 * 4) * (3 - 2)',
    '',
    'If the deal cannot be made into 24, reply with exactly:',
    '',
    '    no solution',
    '',
    'No JSON, no explanation, no "The answer is", no trailing "= 24". Just the',
    'expression itself, or the words "no solution". Think first if you need to,',
    'but make sure the very last line of your reply is the answer and nothing else.'
  ].join('\n')
}

export function buildTwentyFourPrompt(
  state: TwentyFourState,
  player: TwentyFourPlayer,
  rules: TwentyFourRules
): Prompt {
  const lines: string[] = []
  const values = state.cards.map(puzzleValue)

  lines.push(`Puzzle ${state.roundNumber}.`)
  lines.push('')
  lines.push(`Your cards: ${state.cards.map(cardCode).join(' ')}`)
  lines.push(
    'That is ' +
      state.cards.map((card: Card) => `${cardName(card)} = ${puzzleValue(card)}`).join(', ') +
      '.'
  )
  lines.push('')
  lines.push(`Make 24 using ${values.join(', ')} — each exactly once.`)

  if (player.roundsPlayed > 0) {
    lines.push('')
    lines.push(
      `Your record: ${player.solved} solved of ${player.roundsPlayed} puzzles, ` +
        `${player.score} round${player.score === 1 ? '' : 's'} won.`
    )
  }

  lines.push('')
  lines.push('Everyone is answering right now, so the fastest correct answer takes the round.')
  lines.push('An answer that does not evaluate to 24 scores nothing at all.')
  lines.push('')
  lines.push('What is your expression? Reply with just the expression, or "no solution".')

  // Note what is deliberately absent: `state.solution` and `state.solvable`.
  // Both are spectator-only, exactly like poker equity.
  return { system: twentyFourSystemPrompt(rules), user: lines.join('\n') }
}

/** Words a model uses when it means "this deal cannot be done". */
const NO_SOLUTION = [
  'none', 'nosolution', 'nosolutions', 'no', 'impossible', 'unsolvable',
  'notpossible', 'nonexistent', 'na', 'null', 'nothing', 'cannot', 'cant'
]

/**
 * Strips the decoration models put around an answer they were asked for bare.
 *
 * **Never strip a bare `*`.** It is a markdown emphasis marker *and* the
 * multiplication operator, and a blanket `[`*_]` strip silently turned
 * `(6*4)*(3-2)` into `(64)(3-2)` — a valid-looking answer that is not the one
 * the model gave. Only paired markers wrapping the whole line come off.
 */
function cleanAnswer(raw: string): string {
  let out = raw.trim()
  out = out.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '')
  out = out.replace(/`/g, '')
  // Paired emphasis around the entire line only, longest marker first.
  for (const marker of ['***', '**', '_']) {
    if (out.length > marker.length * 2 && out.startsWith(marker) && out.endsWith(marker)) {
      out = out.slice(marker.length, -marker.length).trim()
    }
  }
  // "The answer is: ...", "Answer — ...", "Expression: ..."
  out = out.replace(/^(the\s+)?(answer|expression|solution|result)\s*(is)?\s*[:\-—]?\s*/i, '')
  // A trailing "= 24" is extremely common despite being asked not to.
  out = out.replace(/\s*=\s*24\s*\.?\s*$/, '')
  return out.replace(/\.$/, '').trim()
}

/**
 * Reads an expression, or a claim that the deal has none.
 *
 * The contract asked for is a **bare expression** — no JSON envelope. That is
 * deliberate: the envelope is more to get wrong, more tokens to emit, and it
 * bought nothing that the reasoning channel does not already provide. JSON is
 * still accepted, because a model that volunteers `{"reasoning": …}` should not
 * be punished for being more helpful than asked.
 *
 * `null` is a real answer rather than a parse failure, so it comes back as a
 * value: grading it against the solver is what catches a model claiming "no
 * solution" for a deal that plainly has one.
 */
export function parseTwentyFourReply(text: string): ParseOutcome<string | null> {
  if (!text.trim()) {
    return { ok: false, reasoning: '', problem: 'You replied with nothing at all.' }
  }

  // A model that volunteered JSON is taken at its word, reasoning and all.
  const obj = extractJson(text)
  if (obj) {
    const reasoning = readReasoning(obj)
    const raw = obj.expression ?? obj.answer ?? obj.solution ?? obj.equation ?? obj.result
    if (raw === null) return { ok: true, value: null, reasoning }
    if (typeof raw === 'string' && raw.trim()) {
      return { ok: true, value: readAnswer(cleanAnswer(raw)), reasoning }
    }
    // JSON with no answer in it falls through to the plain-text reader below,
    // rather than being rejected outright.
  }

  // The asked-for shape: the answer, on its own. Models reason first anyway, so
  // read from the bottom — the instruction is that the LAST line is the answer.
  const lines = text
    .split('\n')
    .map((line) => cleanAnswer(line))
    .filter((line) => line.length > 0)

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const word = line.toLowerCase().replace(/[^a-z]/g, '')
    if (NO_SOLUTION.includes(word)) return { ok: true, value: null, reasoning: '' }
    // Anything made only of digits, operators and brackets is an answer. This
    // is a shape test, not a correctness test — see below.
    if (/^[0-9+\-*/×÷·−–()[\]\s]+$/.test(line) && /[0-9]/.test(line)) {
      return { ok: true, value: line, reasoning: '' }
    }
  }

  return {
    ok: false,
    reasoning: '',
    problem:
      'I could not find an answer in that. Reply with only the expression, ' +
      'for example "(6 * 4) * (3 - 2)", or exactly "no solution".'
  }
}

/** "none" and friends mean the deal cannot be done; anything else is an answer. */
function readAnswer(cleaned: string): string | null {
  const word = cleaned.toLowerCase().replace(/[^a-z]/g, '')
  return NO_SOLUTION.includes(word) ? null : cleaned
}
