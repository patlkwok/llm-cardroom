import type { ModelInfo, ReasoningEffort } from '../shared/types.ts'

const BASE_URL = 'https://openrouter.ai/api/v1'
const APP_TITLE = 'LLM Cardroom'
const APP_URL = 'https://github.com/llm-cardroom'

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    /**
     * True for failures no retry can fix and that will hit every subsequent
     * call too — a rejected key, exhausted credits, a forbidden model. These
     * stop the match rather than quietly falling back on every decision.
     */
    readonly fatal = false,
    /**
     * The reply was cut off at `max_tokens`. Retrying the same request is
     * futile — the only thing that helps is a bigger budget.
     */
    readonly truncated = false
  ) {
    super(message)
    this.name = 'OpenRouterError'
  }
}

/** Turns an HTTP status into a human explanation for account-level failures. */
function accountProblem(status: number, detail: string): string | null {
  if (status === 401) {
    return 'OpenRouter rejected the API key (401). It may have been revoked or mistyped — enter it again.'
  }
  if (status === 402) {
    return 'OpenRouter reports insufficient credits (402). Top up the account, then start again.'
  }
  if (status === 403) {
    return `OpenRouter refused the request (403). The key may not be allowed to use this model. ${detail}`.trim()
  }
  return null
}

interface RawModel {
  id: string
  name?: string
  description?: string
  context_length?: number
  pricing?: { prompt?: string; completion?: string }
  architecture?: { modality?: string; input_modalities?: string[] }
}

/**
 * The model catalogue. This endpoint is public, but the key is sent when
 * present so per-account model availability is reflected.
 */
export async function fetchModels(apiKey: string): Promise<ModelInfo[]> {
  const headers: Record<string, string> = {
    'HTTP-Referer': APP_URL,
    'X-Title': APP_TITLE
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  let response: Response
  try {
    response = await fetch(`${BASE_URL}/models`, { headers })
  } catch (cause) {
    throw new OpenRouterError(`Could not reach OpenRouter: ${(cause as Error).message}`, undefined, true)
  }

  if (!response.ok) {
    throw new OpenRouterError(
      `Model list request failed (HTTP ${response.status}): ${await safeText(response)}`,
      response.status
    )
  }

  const body = (await response.json()) as { data?: RawModel[] }
  const models = (body.data ?? [])
    .filter((model) => {
      // Text-in/text-out models only; image and audio models cannot play.
      const inputs = model.architecture?.input_modalities
      return !inputs || inputs.includes('text')
    })
    .map<ModelInfo>((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      contextLength: model.context_length ?? 0,
      // OpenRouter quotes prices per token; per million reads better.
      promptPrice: Number(model.pricing?.prompt ?? 0) * 1_000_000,
      completionPrice: Number(model.pricing?.completion ?? 0) * 1_000_000,
      description: model.description ?? ''
    }))

  models.sort((a, b) => a.name.localeCompare(b.name))
  return models
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  apiKey: string
  model: string
  messages: ChatMessage[]
  reasoningEffort: ReasoningEffort
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Reasoning tokens count against max_tokens, so a thinking model needs far more
 * headroom than a plain one or it burns the whole budget before answering.
 *
 * **`max_tokens` is a ceiling, not a purchase.** Billing is on tokens actually
 * produced, so a generous cap costs nothing for a model that answers concisely —
 * it only changes the outcome for one that would otherwise be cut off mid-
 * thought, and those calls are billed in full today while returning nothing at
 * all. The old `default` of 900 was set when few models reasoned unprompted;
 * it now truncates most frontier models on any question worth asking, which is
 * exactly what it was meant to prevent.
 */
const TOKEN_BUDGET: Record<ReasoningEffort, number> = {
  default: 4000,
  none: 1200,
  low: 6000,
  medium: 12000,
  high: 24000
}

/** The ceiling for a retry after a reply was cut off. */
export const MAX_TOKEN_CEILING = 32000

export function tokenBudget(effort: ReasoningEffort): number {
  return TOKEN_BUDGET[effort] ?? TOKEN_BUDGET.default
}

export interface ChatResult {
  text: string
  /** Some models expose a separate reasoning channel; kept for the UI. */
  reasoning: string
  /**
   * True when the model was cut off at `max_tokens` rather than finishing. It
   * has not failed to follow the format — it never reached the answer — so the
   * only useful response is more headroom, not a correction.
   */
  truncated: boolean
  promptTokens: number
  completionTokens: number
  costUsd: number
}

export async function chatCompletion(request: ChatRequest): Promise<ChatResult> {
  const {
    apiKey, model, messages, reasoningEffort,
    maxTokens = tokenBudget(reasoningEffort),
    timeoutMs = 180_000, signal
  } = request

  if (!apiKey) throw new OpenRouterError('No OpenRouter API key configured.')

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  const composite = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': APP_URL,
        'X-Title': APP_TITLE
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        // No temperature: each model's own default is used.
        ...reasoningBody(reasoningEffort),
        // Ask OpenRouter to report what the call actually cost.
        usage: { include: true }
      }),
      signal: composite
    })

    if (!response.ok) {
      const detail = await safeText(response)
      // 429 and 5xx are worth another attempt; 4xx generally are not.
      const retryable = response.status === 429 || response.status >= 500
      const account = accountProblem(response.status, detail.slice(0, 200))
      throw new OpenRouterError(
        account ?? `HTTP ${response.status}: ${detail.slice(0, 400)}`,
        response.status,
        retryable,
        account !== null
      )
    }

    const body = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string; reasoning?: string }
        finish_reason?: string
        native_finish_reason?: string
        error?: unknown
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
      error?: { message?: string }
    }

    if (body.error) throw new OpenRouterError(body.error.message ?? 'Unknown OpenRouter error')

    const choice = body.choices?.[0]
    const text = choice?.message?.content ?? ''
    const finish = choice?.finish_reason ?? choice?.native_finish_reason ?? ''
    const truncated = finish === 'length' || finish === 'MAX_TOKENS'

    if (!text.trim() && !choice?.message?.reasoning) {
      // Naming the cause matters: retrying an identical request after a
      // truncation just burns the budget again, which is what turned one
      // over-long reply into three of them.
      throw new OpenRouterError(
        truncated
          ? `The model used its whole ${maxTokens}-token budget thinking and never answered.`
          : 'The model returned an empty response.',
        undefined,
        true,
        false,
        truncated
      )
    }

    return {
      text,
      reasoning: choice?.message?.reasoning ?? '',
      truncated,
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
      costUsd: body.usage?.cost ?? 0
    }
  } catch (error) {
    if (error instanceof OpenRouterError) throw error
    if ((error as Error).name === 'AbortError') {
      if (signal?.aborted) throw new OpenRouterError('Cancelled.')
      throw new OpenRouterError(`The model did not answer within ${Math.round(timeoutMs / 1000)}s.`, undefined, true)
    }
    throw new OpenRouterError((error as Error).message, undefined, true)
  } finally {
    clearTimeout(timer)
  }
}

/** Confirms a key works by asking for the account's credit balance. */
export async function verifyKey(apiKey: string): Promise<{ ok: boolean; detail: string }> {
  if (!apiKey.trim()) return { ok: false, detail: 'Enter a key first.' }
  try {
    const response = await fetch(`${BASE_URL}/key`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (response.status === 401) return { ok: false, detail: 'That key was rejected (401).' }
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}: ${await safeText(response)}` }

    const body = (await response.json()) as {
      data?: { label?: string; usage?: number; limit?: number | null }
    }
    // Note: `usage` is this key's all-time spend across every app that has used
    // it — not this app, and not this session. The Usage tab tracks the session.
    const usage = body.data?.usage ?? 0
    const limit = body.data?.limit
    const detail =
      limit === null || limit === undefined
        ? `Key accepted. It has spent $${usage.toFixed(2)} on OpenRouter all-time (no cap set).`
        : `Key accepted. It has spent $${usage.toFixed(2)} of its $${limit.toFixed(2)} all-time cap.`
    return { ok: true, detail }
  } catch (error) {
    return { ok: false, detail: `Could not reach OpenRouter: ${(error as Error).message}` }
  }
}

/**
 * Builds the `reasoning` field. 'default' omits it entirely so the model's own
 * behaviour is untouched; models that cannot reason ignore whatever we send.
 */
function reasoningBody(effort: ReasoningEffort): Record<string, unknown> {
  if (effort === 'default') return {}
  if (effort === 'none') return { reasoning: { enabled: false } }
  return { reasoning: { effort } }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim()
  } catch {
    return '(no response body)'
  }
}
