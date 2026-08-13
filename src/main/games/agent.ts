import {
  chatCompletion,
  MAX_TOKEN_CEILING,
  OpenRouterError,
  tokenBudget,
  type ChatMessage
} from '../openrouter.ts'
import type { PlayerConfig } from '../../shared/types.ts'
import type { ParseOutcome, Prompt } from './prompts/shared.ts'

export interface AgentResult<T> {
  action: T
  reasoning: string
  attempts: number
  /** Present when the model never produced a usable action. */
  fallbackReason?: string
  /**
   * Set when the failure will repeat on every call (bad key, no credits). The
   * caller should stop rather than fall back for the rest of the match.
   */
  fatalReason?: string
  /** Wall-clock across every attempt, retries and backoff included. */
  latencyMs: number
  /**
   * Just the attempt that produced the answer, with retries and their backoff
   * excluded. This is what a simultaneous game ranks on: `latencyMs` would let
   * a 429 — which firing N calls at once is exactly what provokes — decide the
   * round for reasons that have nothing to do with the question asked.
   */
  finalAttemptMs: number
  promptTokens: number
  completionTokens: number
  costUsd: number
}

export interface DecisionRequest<T> {
  apiKey: string
  player: PlayerConfig
  prompt: Prompt
  parse: (text: string) => ParseOutcome<T>
  /** Used when every attempt fails, so the table can always keep moving. */
  fallback: T
  signal?: AbortSignal
  maxAttempts?: number
  /**
   * Starting token budget. Defaults to the player's reasoning effort; a game
   * that asks a genuinely harder question can start higher.
   */
  maxTokens?: number
  onAttemptFailed?: (attempt: number, problem: string) => void
}

/** How much more headroom a retry gets after a reply was cut off. */
const TRUNCATION_GROWTH = 2.5

/**
 * Asks a model for one decision, correcting it in-conversation when the reply
 * is unusable. Always returns something so a game never stalls on a bad model.
 */
export async function requestDecision<T>(request: DecisionRequest<T>): Promise<AgentResult<T>> {
  const { apiKey, player, prompt, parse, fallback, signal, maxAttempts = 3 } = request
  const started = Date.now()

  const messages: ChatMessage[] = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user }
  ]

  let promptTokens = 0
  let completionTokens = 0
  let costUsd = 0
  let lastProblem = 'The model never returned a usable action.'
  let lastReasoning = ''
  let fatalReason: string | undefined

  let finalAttemptMs = 0
  let budget = request.maxTokens ?? tokenBudget(player.reasoningEffort)

  /** More headroom for the next attempt, or null once there is no more to give. */
  const grow = (): number | null => {
    if (budget >= MAX_TOKEN_CEILING) return null
    budget = Math.min(Math.round(budget * TRUNCATION_GROWTH), MAX_TOKEN_CEILING)
    return budget
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) break

    let text: string
    let reasoningChannel = ''
    let truncated = false
    const attemptStarted = Date.now()
    try {
      const result = await chatCompletion({
        apiKey,
        model: player.modelId,
        messages,
        reasoningEffort: player.reasoningEffort,
        maxTokens: budget,
        signal
      })
      text = result.text
      reasoningChannel = result.reasoning
      truncated = result.truncated
      promptTokens += result.promptTokens
      completionTokens += result.completionTokens
      costUsd += result.costUsd
      finalAttemptMs = Date.now() - attemptStarted
    } catch (error) {
      const err = error as OpenRouterError
      finalAttemptMs = Date.now() - attemptStarted
      lastProblem = err.message
      if (signal?.aborted) break
      if (err instanceof OpenRouterError && err.fatal) {
        // No point asking again, or asking anyone else.
        fatalReason = err.message
        break
      }
      request.onAttemptFailed?.(attempt, err.message)

      // A reply cut off at the token ceiling is not a formatting mistake, and
      // asking again for the same thing under the same cap just spends the
      // budget a second time. Give it room instead.
      if (err instanceof OpenRouterError && err.truncated && attempt < maxAttempts) {
        const grown = grow()
        if (grown !== null) {
          request.onAttemptFailed?.(attempt, `Retrying with a ${grown}-token budget.`)
          continue
        }
      }

      // Only network-ish failures are worth another try; a bad model id is not.
      if (!(err instanceof OpenRouterError) || !err.retryable || attempt === maxAttempts) break
      await sleep(600 * attempt)
      continue
    }

    const outcome = parse(text)
    if (outcome.reasoning) lastReasoning = outcome.reasoning
    else if (reasoningChannel) lastReasoning = capReasoning(reasoningChannel)

    if (outcome.ok && outcome.value !== undefined) {
      return {
        action: outcome.value,
        reasoning: lastReasoning || '(no reasoning given)',
        attempts: attempt,
        latencyMs: Date.now() - started,
        finalAttemptMs,
        promptTokens,
        completionTokens,
        costUsd
      }
    }

    // A truncated reply that will not parse is the same problem as an empty
    // one: the model ran out of room mid-thought and never reached its answer.
    // Correcting its formatting is the wrong feedback — it did not get far
    // enough to have any — and it wastes the remaining attempts.
    if (truncated && attempt < maxAttempts) {
      const grown = grow()
      if (grown !== null) {
        lastProblem = `Cut off after ${budget} tokens before answering.`
        request.onAttemptFailed?.(attempt, `${lastProblem} Retrying with a ${grown}-token budget.`)
        continue
      }
    }

    lastProblem = outcome.problem ?? 'Unusable reply.'
    request.onAttemptFailed?.(attempt, lastProblem)

    if (attempt < maxAttempts) {
      messages.push({ role: 'assistant', content: text.slice(0, 2000) })
      // Deliberately does not name a format: the games disagree about what a
      // reply looks like (JSON for most, a bare expression for the 24 puzzle),
      // and the parser's own `problem` already says what was wrong with this
      // particular one.
      messages.push({
        role: 'user',
        content: `${lastProblem}\n\nTry again, and reply with the answer only, in the format you were asked for.`
      })
    }
  }

  return {
    action: fallback,
    reasoning: lastReasoning,
    attempts: maxAttempts,
    fallbackReason: lastProblem,
    fatalReason,
    latencyMs: Date.now() - started,
    finalAttemptMs,
    promptTokens,
    completionTokens,
    costUsd
  }
}

/**
 * A safety cap on a reasoning trace, not a display limit.
 *
 * This used to cut to the first ~320 characters, which meant the full trace
 * never reached the renderer and so could not be expanded there however the UI
 * asked for it. Clamping is the UI's job; this only stops a pathological trace
 * from bloating the event stream and the feed's 250-record buffer.
 */
function capReasoning(text: string, limit = 4000): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
