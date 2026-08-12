/** Prompt plumbing shared by every game: the notation block, and reply parsing. */

export interface Prompt {
  system: string
  user: string
}

export const NOTATION =
  'Card notation is rank followed by suit: "As" = ace of spades, "Td" = ten of diamonds, ' +
  '"9c" = nine of clubs, "2h" = two of hearts. Suits are s=spades, h=hearts, d=diamonds, c=clubs.'

export interface ParseOutcome<T> {
  ok: boolean
  value?: T
  reasoning: string
  /** Feedback handed back to the model when the reply was unusable. */
  problem?: string
}

/** The reply was not JSON at all — the same complaint from every parser. */
export function notJson<T>(): ParseOutcome<T> {
  return {
    ok: false,
    reasoning: '',
    problem: 'Your reply was not valid JSON. Reply with only a JSON object.'
  }
}

/**
 * Pulls a JSON object out of a model reply. Handles fenced code blocks and
 * models that wrap their JSON in prose.
 */
export function extractJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const candidates: string[] = []

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  candidates.push(trimmed)

  // Last resort: the widest balanced brace span in the text.
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

export function readReasoning(obj: Record<string, unknown>): string {
  for (const key of ['reasoning', 'reason', 'thinking', 'thought', 'explanation', 'rationale']) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}
