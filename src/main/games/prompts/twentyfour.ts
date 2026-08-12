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
    'If there is genuinely no way, answer with "none" — that is a correct answer and scores.',
    'Guessing an expression that does not actually evaluate to 24 scores nothing, so check',
    'your arithmetic before answering rather than submitting something that looks close.',
    '',
    'Reply with a single JSON object and nothing else, in exactly this shape:',
    '{"reasoning": "<one short sentence>", "expression": "<your expression, or \\"none\\">"}',
    '',
    'Examples of the shape: {"reasoning": "6 times 4.", "expression": "(6 * 4) * (3 - 2)"}',
    'or {"reasoning": "No combination reaches 24.", "expression": "none"}'
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
  lines.push('What is your expression?')

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
 * Reads an expression, or a claim that the deal has none.
 *
 * `null` is a real answer here rather than a parse failure, so it is returned as
 * a value: grading it against the solver is what catches a model that says "no
 * solution" to a deal that plainly has one.
 */
export function parseTwentyFourReply(text: string): ParseOutcome<string | null> {
  const obj = extractJson(text)
  if (!obj) return notJson()
  const reasoning = readReasoning(obj)

  const raw = obj.expression ?? obj.answer ?? obj.solution ?? obj.equation ?? obj.result
  if (raw === null) return { ok: true, value: null, reasoning }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      reasoning,
      problem: 'Your JSON needs an "expression" string, or "none" if there is no solution.'
    }
  }

  const trimmed = raw.trim()
  if (!trimmed) {
    return {
      ok: false,
      reasoning,
      problem: 'Your "expression" was empty. Give an expression, or "none".'
    }
  }

  const word = trimmed.toLowerCase().replace(/[^a-z]/g, '')
  if (NO_SOLUTION.includes(word)) return { ok: true, value: null, reasoning }

  // Models often answer "(6*4)*(3-2) = 24"; keep only the expression itself.
  const withoutTarget = trimmed.replace(/\s*=\s*24\s*$/, '').trim()

  // Any well-formed reply is accepted here, even an expression that is wrong or
  // does not parse. Grading belongs to the engine, not to this parser, and that
  // is a deliberate split: `agent.ts` retries whatever a parser rejects, so
  // rejecting bad arithmetic would hand one model three attempts at the puzzle
  // while another got one. Catching an expression that does not evaluate is the
  // point of the game, not an error to be corrected out of the model.
  return { ok: true, value: withoutTarget || trimmed, reasoning }
}
