/**
 * Arithmetic-expression parsing and evaluation for the 24 puzzle.
 *
 * Two rules govern this file, and both are cheap to get wrong:
 *
 * 1. **Never `eval` the model's expression.** The string comes from a language
 *    model; a recursive-descent parser over four operators is the only safe way
 *    to read it, and it is not much code.
 * 2. **Evaluate in exact rationals, not floats.** The classic `8/(3-8/3)` is
 *    24 exactly, and is *not* 24 in floating point.
 */

/** An exact rational. Always kept in lowest terms with a positive denominator. */
export interface Frac {
  n: number
  d: number
}

function gcd(a: number, b: number): number {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b) [a, b] = [b, a % b]
  return a
}

export function frac(n: number, d = 1): Frac {
  if (d === 0) throw new RangeError('division by zero')
  if (d < 0) {
    n = -n
    d = -d
  }
  const g = gcd(n, d) || 1
  return { n: n / g, d: d / g }
}

export const add = (a: Frac, b: Frac): Frac => frac(a.n * b.d + b.n * a.d, a.d * b.d)
export const sub = (a: Frac, b: Frac): Frac => frac(a.n * b.d - b.n * a.d, a.d * b.d)
export const mul = (a: Frac, b: Frac): Frac => frac(a.n * b.n, a.d * b.d)
export const div = (a: Frac, b: Frac): Frac => {
  if (b.n === 0) throw new RangeError('division by zero')
  return frac(a.n * b.d, a.d * b.n)
}

export const equals = (a: Frac, b: Frac): boolean => a.n === b.n && a.d === b.d

/** "24", or "71/3" when it does not come out whole. */
export function formatFrac(value: Frac): string {
  return value.d === 1 ? String(value.n) : `${value.n}/${value.d}`
}

export const TARGET: Frac = { n: 24, d: 1 }

/* --------------------------------------------------------------- parsing */

type Token = { kind: 'num'; value: number } | { kind: 'op'; value: string }

function tokenise(text: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (/[0-9]/.test(ch)) {
      let digits = ''
      while (i < text.length && /[0-9]/.test(text[i])) digits += text[i++]
      tokens.push({ kind: 'num', value: Number(digits) })
      continue
    }
    // Accept the symbols people and models actually type, not just ASCII.
    const normalised = ({ '×': '*', '·': '*', '÷': '/', '−': '-', '–': '-', '[': '(', ']': ')' } as Record<string, string>)[ch] ?? ch
    if ('+-*/()'.includes(normalised)) {
      tokens.push({ kind: 'op', value: normalised })
      i++
      continue
    }
    return null
  }
  return tokens
}

export interface ParsedExpression {
  evaluate: () => Frac
  /** The numbers appearing in the expression, in order. */
  leaves: number[]
}

export interface ParseResult {
  ok: boolean
  expression?: ParsedExpression
  problem?: string
}

/**
 * Recursive descent over `+ - * /`, parentheses and unary minus.
 *
 * Unary minus is accepted deliberately: it cannot break the used-each-card-once
 * check, because the leaf is still the number itself, and rejecting it would
 * only manufacture parse failures for expressions that are perfectly valid.
 */
export function parseExpression(text: string): ParseResult {
  const tokens = tokenise(text)
  if (!tokens) {
    return { ok: false, problem: 'Use only whole numbers, + - * / and brackets.' }
  }
  if (tokens.length === 0) return { ok: false, problem: 'The expression was empty.' }

  let pos = 0
  const leaves: number[] = []
  let failure: string | null = null

  const peek = (): Token | undefined => tokens[pos]
  const eat = (value: string): boolean => {
    const token = peek()
    if (token && token.kind === 'op' && token.value === value) {
      pos++
      return true
    }
    return false
  }

  type Node = () => Frac

  function parsePrimary(): Node | null {
    const token = peek()
    if (!token) {
      failure ??= 'The expression ends unexpectedly.'
      return null
    }
    if (token.kind === 'num') {
      pos++
      leaves.push(token.value)
      const value = frac(token.value)
      return () => value
    }
    if (token.value === '-') {
      pos++
      const inner = parsePrimary()
      if (!inner) return null
      return () => sub(frac(0), inner())
    }
    if (token.value === '(') {
      pos++
      const inner = parseSum()
      if (!inner) return null
      if (!eat(')')) {
        failure ??= 'A bracket is not closed.'
        return null
      }
      return inner
    }
    failure ??= `Unexpected "${token.value}" in the expression.`
    return null
  }

  // Both loops keep `left` non-nullable, with the null case handled once up
  // front. A `Node | null` accumulator that is reassigned to a closure over its
  // own previous value defeats TypeScript's inference entirely (TS7022).
  function parseProduct(): Node | null {
    const first = parsePrimary()
    if (!first) return null
    let left: Node = first
    for (;;) {
      const token = peek()
      if (!token || token.kind !== 'op' || (token.value !== '*' && token.value !== '/')) break
      const op = token.value
      pos++
      const right = parsePrimary()
      if (!right) return null
      const l: Node = left
      left = op === '*' ? (): Frac => mul(l(), right()) : (): Frac => div(l(), right())
    }
    return left
  }

  function parseSum(): Node | null {
    const first = parseProduct()
    if (!first) return null
    let left: Node = first
    for (;;) {
      const token = peek()
      if (!token || token.kind !== 'op' || (token.value !== '+' && token.value !== '-')) break
      const op = token.value
      pos++
      const right = parseProduct()
      if (!right) return null
      const l: Node = left
      left = op === '+' ? (): Frac => add(l(), right()) : (): Frac => sub(l(), right())
    }
    return left
  }

  const root = parseSum()
  if (!root) return { ok: false, problem: failure ?? 'The expression could not be read.' }
  if (pos !== tokens.length) {
    return { ok: false, problem: 'There is unexpected text after the expression.' }
  }

  return { ok: true, expression: { evaluate: root, leaves } }
}

export interface ValidationResult {
  ok: boolean
  /** The exact value the expression comes to, when it could be evaluated. */
  value?: Frac
  problem?: string
}

/**
 * Checks an expression against a deal: it must parse, it must use the four card
 * values **as a multiset**, and it must evaluate without dividing by zero.
 *
 * The multiset check is the subtle one. Duplicate cards are legal, so `[8,8,3,3]`
 * must accept an answer using both eights and reject one that uses a single
 * eight twice.
 */
export function validateExpression(text: string, values: number[]): ValidationResult {
  const parsed = parseExpression(text)
  if (!parsed.ok || !parsed.expression) return { ok: false, problem: parsed.problem }

  const used = [...parsed.expression.leaves].sort((a, b) => a - b)
  const expected = [...values].sort((a, b) => a - b)
  if (used.length !== expected.length || used.some((n, i) => n !== expected[i])) {
    return {
      ok: false,
      problem:
        `You must use each of ${expected.join(', ')} exactly once. ` +
        `Your expression used ${used.length ? used.join(', ') : 'nothing'}.`
    }
  }

  try {
    return { ok: true, value: parsed.expression.evaluate() }
  } catch {
    return { ok: false, problem: 'That expression divides by zero.' }
  }
}
