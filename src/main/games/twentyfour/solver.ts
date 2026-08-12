import { add, div, equals, frac, mul, sub, TARGET, type Frac } from './expression.ts'

/**
 * Brute force over every way of combining four numbers with + - * / and
 * brackets, in the same exact rationals the validator uses.
 *
 * Used three ways, and it matters that it is the same code for all three:
 * marking a deal solvable, showing the operator a worked answer afterwards, and
 * grading a model's claim that a deal has no solution. A model should never be
 * told it is wrong by a solver weaker than the one that dealt the puzzle.
 */

interface Term {
  value: Frac
  /** How this term was built, already bracketed where it needs to be. */
  text: string
}

/**
 * Repeatedly replaces a pair of terms with one combined term, which covers
 * every bracketing of every ordering without enumerating parse trees.
 */
function search(terms: Term[]): string | null {
  if (terms.length === 1) {
    return equals(terms[0].value, TARGET) ? terms[0].text : null
  }

  for (let i = 0; i < terms.length; i++) {
    for (let j = 0; j < terms.length; j++) {
      if (i === j) continue
      const a = terms[i]
      const b = terms[j]
      const rest = terms.filter((_, k) => k !== i && k !== j)

      const combinations: Array<[Frac, string] | null> = [
        // Addition and multiplication commute, so only do them one way round.
        j > i ? [add(a.value, b.value), `${a.text} + ${b.text}`] : null,
        j > i ? [mul(a.value, b.value), `${a.text} * ${b.text}`] : null,
        [sub(a.value, b.value), `${a.text} - ${b.text}`],
        b.value.n !== 0 ? [div(a.value, b.value), `${a.text} / ${b.text}`] : null
      ]

      for (const combination of combinations) {
        if (!combination) continue
        const [value, text] = combination
        const found = search([...rest, { value, text: `(${text})` }])
        if (found) return found
      }
    }
  }
  return null
}

/**
 * One worked solution for these four values, or null when there is none.
 * The outermost brackets are stripped, so it reads as `(8 / (3 - (8 / 3)))`
 * rather than with a redundant pair around the whole thing.
 */
export function solve(values: number[]): string | null {
  const found = search(values.map((value) => ({ value: frac(value), text: String(value) })))
  if (!found) return null
  return found.startsWith('(') && found.endsWith(')') ? found.slice(1, -1) : found
}

export function isSolvable(values: number[]): boolean {
  return solve(values) !== null
}
