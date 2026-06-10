import OpenAI from 'openai'
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions.mjs'
import type { Stream } from 'openai/streaming.mjs'

export type ChatTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; createdAt?: number; toolCalls?: AssistantToolCall[]; tokensPrompt?: number; tokensCompletion?: number; tokensCached?: number; tokensCost?: number; provider?: string; model?: string }
  | { role: 'tool'; toolCallId: string; content: string }
  | { role: 'system'; content: string }

export type AssistantToolCall = {
  id: string
  name: string
  arguments: string
}

export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'tool-result'; id: string; name: string; result: string; ok: boolean }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number; cachedTokens?: number; totalCost?: number; promptTokensLast?: number }
  | { type: 'retry-wait'; reason: string; delayMs: number; attempt: number; max: number }
  | { type: 'done'; finish_reason: string | null }
  | { type: 'error'; message: string }

export class LlmClient {
  private client: OpenAI
  readonly model: string
  /** Request `usage.cost` (USD) from providers needing explicit
   * `usage: { include: true }` in the body — e.g. OpenRouter. */
  private readonly includeUsageAccounting: boolean
  /** OpenRouter middle-out: `transforms: ["middle-out"]` in the body. */
  private readonly middleOut: boolean
  /** Min interval between requests (ms) — optional client-side
   * throttle to avoid bans from strict providers. */
  private readonly minRequestIntervalMs: number
  /** Last request time (Date.now()) for throttling. */
  private lastRequestAt: number = 0

  constructor(opts: { apiKey: string; baseURL?: string; model?: string; llmProxy?: string; llmProxyUser?: string; llmProxyPassword?: string; tlsInsecure?: boolean; caCert?: string; apiFormat?: 'openai'; includeUsageAccounting?: boolean; middleOut?: boolean; minRequestIntervalMs?: number | null }) {
    const proxyUrl = opts.llmProxy ? buildProxyUrl(opts.llmProxy, opts.llmProxyUser, opts.llmProxyPassword) : undefined
    const caBuf = opts.caCert ? Buffer.from(opts.caCert, 'utf8') : undefined
    const needCustomFetch = !!(opts.llmProxy || opts.tlsInsecure || caBuf)
    const fetchFn = needCustomFetch
      ? (url: string | URL, init?: RequestInit) => {
          const extra: Record<string, unknown> = {}
          if (proxyUrl) extra['proxy'] = proxyUrl
          const tls: Record<string, unknown> = {}
          if (opts.tlsInsecure) tls['rejectUnauthorized'] = false
          if (caBuf) tls['ca'] = caBuf
          if (Object.keys(tls).length) extra['tls'] = tls
          return fetch(url, { ...init, ...extra } as RequestInit)
        }
      : undefined
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, fetch: fetchFn })
    this.model = opts.model ?? 'gpt-4.1-mini'
    this.includeUsageAccounting = !!opts.includeUsageAccounting
    this.middleOut = !!opts.middleOut
    this.minRequestIntervalMs = (typeof opts.minRequestIntervalMs === 'number' && opts.minRequestIntervalMs > 0)
      ? opts.minRequestIntervalMs : 0
  }

  /** Run an agent loop streaming events until model stops requesting tools. */
  async *runAgent(
    history: ChatTurn[],
    tools: ChatCompletionTool[],
    runTool: (name: string, args: string) => Promise<string>,
    opts?: {
      maxTurns?: number
      signal?: AbortSignal
      agentState?: { checkpointSummary?: string }
      getExtraSystemMsgs?: () => string[]
      /** Override the model for this run only (e.g. cheaper compactModel). */
      modelOverride?: string
      /** Sampling temperature (0..2). Undefined → omit, provider chooses default. */
      temperature?: number
      /** Builds the post-checkpoint «continue» system message from the summary.
       * Caller supplies it so the text follows the UI/assistant language. */
      checkpointMessage?: (summary: string) => string
      /** Loader for image attachments: id → buffer/mime. If set, `[file:id:name]`
       * tokens in user messages for image extensions become multi-modal
       * content (`type: 'image_url'`) — model gets the image natively via
       * vision API. For non-image files or without a loader, tokens stay in text. */
      loadAttachmentBuffer?: (id: string) => { buffer: Buffer; mime: string } | null
    },
  ): AsyncGenerator<StreamEvent> {
    const maxTurns = opts?.maxTurns ?? 8
    const activeModel = opts?.modelOverride?.trim() || this.model
    const temperature = typeof opts?.temperature === 'number' && Number.isFinite(opts.temperature)
      ? opts.temperature
      : undefined
    const messages = history.map((t) => toApi(t, opts?.loadAttachmentBuffer))
    let totalPromptTokens = 0
    let totalCompletionTokens = 0
    let totalCachedTokens = 0
    let totalCost = 0  // VseGPT/OpenRouter style — provider-reported cost in their currency
    let lastPromptTokens = 0  // prompt_tokens of the LAST internal LLM call — post-compaction size

    for (let turn = 0; turn < maxTurns; turn++) {
      const isLastTurn = turn === maxTurns - 1
      const extraMsgs = opts?.getExtraSystemMsgs?.() ?? []
      const injected: ChatCompletionMessageParam[] = extraMsgs.map((content) => ({
        role: 'system' as const,
        content,
      }))
      if (isLastTurn) {
        injected.push({
          role: 'system',
          content: '⚠ LAST ITERATION OF THE AGENT LOOP. Do NOT call tools. Give the final answer based on the information already gathered.',
        })
      }
      const messagesForApi: ChatCompletionMessageParam[] = messages.length > 0
        ? [messages[0]!, ...injected, ...messages.slice(1)]
        : [...injected]

      let stream: Stream<ChatCompletionChunk>
      const createBody: Record<string, unknown> = {
        model: activeModel,
        messages: messagesForApi,
        tools: isLastTurn ? undefined : (tools.length ? tools : undefined),
        stream: true,
        stream_options: { include_usage: true },
      }
      if (temperature !== undefined) createBody['temperature'] = temperature
      // OpenRouter: explicitly request `cost` in usage.
      if (this.includeUsageAccounting) createBody['usage'] = { include: true }
      // OpenRouter middle-out — server-side compaction on window overflow.
      if (this.middleOut) createBody['transforms'] = ['middle-out']

      // Client-side throttle — at most one request per N ms.
      // Helps avoid bans from strict providers.
      if (this.minRequestIntervalMs > 0) {
        const since = Date.now() - this.lastRequestAt
        if (since < this.minRequestIntervalMs) {
          await new Promise((r) => setTimeout(r, this.minRequestIntervalMs - since))
        }
      }
      this.lastRequestAt = Date.now()

      // Retry on 429 (rate limit) with backoff. Free-tier OpenRouter models
      // often hit the provider's upstream limit — give it a chance to pass.
      // Fixed backoff: 3s / 8s / 20s (3 attempts).
      const RETRY_DELAYS = [3000, 8000, 20000]
      let attempt = 0
      let createError: unknown = null
      while (true) {
        try {
          stream = await this.client.chat.completions.create(createBody as any) as unknown as Stream<ChatCompletionChunk>
          createError = null
          break
        } catch (e: any) {
          createError = e
          const status = e?.status ?? e?.error?.code
          if (status !== 429 || attempt >= RETRY_DELAYS.length) break
          const delay = RETRY_DELAYS[attempt]!
          yield {
            type: 'retry-wait',
            reason: 'Провайдер вернул 429 (rate limit). Ждём и пробуем снова.',
            delayMs: delay,
            attempt: attempt + 1,
            max: RETRY_DELAYS.length,
          }
          await new Promise((r) => setTimeout(r, delay))
          attempt++
        }
      }
      if (createError) {
        yield { type: 'error', message: formatLlmError(createError) }
        return
      }
      stream = stream!

      let text = ''
      const toolBuf = new Map<number, { id: string; name: string; args: string }>()
      let finish: string | null = null

      try {
        for await (const chunk of stream) {
          if (opts?.signal?.aborted) {
            yield { type: 'error', message: 'aborted' }
            return
          }
          if (chunk.usage) {
            // All usage fields are optional — VseGPT may omit any of them
            totalPromptTokens += chunk.usage.prompt_tokens ?? 0
            totalCompletionTokens += chunk.usage.completion_tokens ?? 0
            totalCachedTokens += chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
            lastPromptTokens = chunk.usage.prompt_tokens ?? lastPromptTokens
            // Server-side billing in the provider's currency. Gateways
            // use different field names:
            //   VseGPT — total_cost (USD)
            //   AITunnel — cost_rub (RUB)
            //   OpenRouter — cost (USD), requires `usage: { include: true }`
            //     in the request, else the field is absent.
            // Single tokensCost field on the frontend, currency from PROVIDER_INFO.
            const u = chunk.usage as { total_cost?: number; cost_rub?: number; cost?: number }
            const c = u.total_cost ?? u.cost_rub ?? u.cost
            if (typeof c === 'number') totalCost += c
            // Emit progress immediately — frontend updates header counters
            // in real time, without waiting for the agent loop to finish.
            yield {
              type: 'usage',
              promptTokens: totalPromptTokens,
              completionTokens: totalCompletionTokens,
              cachedTokens: totalCachedTokens,
              ...(totalCost > 0 ? { totalCost } : {}),
              promptTokensLast: lastPromptTokens,
            }
          }
          const choice = chunk.choices[0]
          if (!choice) continue
          const delta = choice.delta
          if (delta?.content) {
            text += delta.content
            yield { type: 'text-delta', text: delta.content }
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const slot = toolBuf.get(tc.index) ?? { id: '', name: '', args: '' }
              if (tc.id) slot.id = tc.id
              if (tc.function?.name) slot.name = tc.function.name
              if (tc.function?.arguments) slot.args += tc.function.arguments
              toolBuf.set(tc.index, slot)
            }
          }
          if (choice.finish_reason) finish = choice.finish_reason
        }
      } catch (e: any) {
        yield { type: 'error', message: `Stream error: ${e?.message ?? String(e)}` }
        return
      }

      const toolCalls = [...toolBuf.values()].filter((t) => t.id && t.name)
      if (!toolCalls.length) {
        if (totalPromptTokens || totalCompletionTokens) {
          yield {
            type: 'usage',
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            cachedTokens: totalCachedTokens,
            ...(totalCost > 0 ? { totalCost } : {}),
          }
        }
        yield { type: 'done', finish_reason: finish }
        return
      }

      messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: t.args },
        })),
      })

      for (const t of toolCalls) {
        yield { type: 'tool-call', id: t.id, name: t.name, arguments: t.args }
        let result: string
        let ok = true
        try {
          result = await runTool(t.name, t.args)
        } catch (e: any) {
          ok = false
          result = `Error: ${e?.message ?? String(e)}`
        }
        yield { type: 'tool-result', id: t.id, name: t.name, result, ok }
        messages.push({ role: 'tool', tool_call_id: t.id, content: result })
      }

      // Handle checkpoint: compress working messages
      if (opts?.agentState?.checkpointSummary) {
        const summary = opts.agentState.checkpointSummary
        delete opts.agentState.checkpointSummary
        const thisRoundCount = toolCalls.length + 1  // assistant msg + tool results
        const thisRound = messages.slice(-thisRoundCount)
        const sysMsg = messages[0]
        messages.length = 0
        if (sysMsg) messages.push(sysMsg)
        // Inject an explicit nudge: after a checkpoint the model often emits
        // «I'll check next...» and stops, waiting for the user to poke it. A
        // clear instruction to continue or give a final answer keeps the
        // agent loop alive without user input.
        messages.push({
          role: 'system',
          content: opts?.checkpointMessage
            ? opts.checkpointMessage(summary)
            : `Чекпоинт — итог предыдущего этапа:\n${summary}\n\n` +
              'Сделан checkpoint, история сжата. ПРОДОЛЖАЙ выполнение текущей задачи: ' +
              'следующий шаг по плану через нужный инструмент. Если задача полностью ' +
              'завершена и больше делать нечего — дай финальный ответ пользователю. ' +
              'Не пиши «дальше проверю / посмотрю / попробую» как обещание — сразу делай.',
        })
        messages.push(...thisRound)
      }
    }

    if (totalPromptTokens || totalCompletionTokens) {
      yield { type: 'usage', promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, cachedTokens: totalCachedTokens }
    }
    yield { type: 'done', finish_reason: 'max_turns' }
  }
}

/**
 * Turns an OpenAI SDK / fetch error into a human-readable message.
 * Covers AITunnel-specific codes ([docs](https://docs.aitunnel.ru/api/errors.html));
 * the same codes from other OpenAI-compatible gateways are treated identically.
 *
 * AITunnel response shape: `{ error: { code: number, message: string, metadata? } }`,
 * OpenAI: `{ error: { message, type, code? } }`. Handles both.
 */
export function formatLlmError(e: unknown): string {
  const err = e as { status?: number; message?: string; error?: any; cause?: any }
  // OpenAI SDK puts the parsed body in `err.error`
  const body = err?.error
  const status = err?.status
  const innerCode = (typeof body?.code === 'number' ? body.code : undefined)
                  ?? (typeof body?.error?.code === 'number' ? body.error.code : undefined)
  const httpCode = innerCode ?? status
  const innerMsg: string | undefined = body?.message ?? body?.error?.message
  const meta = body?.metadata ?? body?.error?.metadata
  const detail = innerMsg ?? err?.message ?? String(e)
  switch (httpCode) {
    case 400: return `Неверный запрос (400): ${detail}`
    case 401: return `Недействительный API-ключ (401). Проверь ключ в настройках. ${detail}`
    case 402: {
      // AITunnel 402 = insufficient funds; meta may carry `provider_name`
      return `Недостаточно средств на счёте провайдера (402). ${detail}`
    }
    case 403: {
      const reasons: unknown = meta?.reasons
      const flagged: unknown = meta?.flagged_input
      const provider: unknown = meta?.provider_name
      const parts = [`Запрос отклонён модерацией (403)`]
      if (Array.isArray(reasons) && reasons.length) parts.push(`причина: ${reasons.join(', ')}`)
      if (typeof flagged === 'string') parts.push(`фрагмент: «${flagged.slice(0, 100)}»`)
      if (typeof provider === 'string') parts.push(`провайдер: ${provider}`)
      parts.push(detail)
      return parts.join(' — ')
    }
    case 408: return `Превышено время ожидания (408). Попробуй ещё раз. ${detail}`
    case 429: return `Превышен лимит запросов (429). Подожди и попробуй снова. ${detail}`
    case 502: {
      const provider: unknown = meta?.provider_name
      const raw: unknown = meta?.raw
      const parts = [`Модель временно недоступна (502)`]
      if (typeof provider === 'string') parts.push(`провайдер: ${provider}`)
      if (typeof raw === 'string') parts.push(`upstream: ${raw}`)
      parts.push(detail)
      return parts.join(' — ')
    }
    default:
      return `LLM error: ${detail}`
  }
}

function buildProxyUrl(proxy: string, user?: string, password?: string): string {
  if (!user) return proxy
  try {
    const u = new URL(proxy)
    u.username = encodeURIComponent(user)
    if (password) u.password = encodeURIComponent(password)
    return u.toString()
  } catch {
    return proxy
  }
}

/** Extensions we pass as images via the vision API. */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i

/** Detect mime-type from filename for a data: URL. */
function imageMime(name: string): string {
  const ext = name.toLowerCase().match(/\.(png|jpe?g|gif|webp)$/)?.[1] ?? 'png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/png'
}

function toApi(
  t: ChatTurn,
  loadAttachment?: (id: string) => { buffer: Buffer; mime: string } | null,
): ChatCompletionMessageParam {
  if (t.role === 'tool') return { role: 'tool', tool_call_id: t.toolCallId, content: t.content }
  if (t.role === 'assistant') {
    if (t.toolCalls?.length) {
      return {
        role: 'assistant',
        content: t.content || null,
        tool_calls: t.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        })),
      }
    }
    return { role: 'assistant', content: t.content }
  }
  if (t.role === 'system') return { role: 'system', content: t.content }

  // user. Parse `[file:id:name]` tokens — image extensions become
  // multi-modal content (vision API); others keep the token in text so the
  // model sees what's attached and can call read_attachment if needed.
  if (loadAttachment) {
    const re = /\[file:([^:\]]+):([^\]]+)\]\s*/g
    const images: { id: string; name: string }[] = []
    const cleanedText = t.content.replace(re, (match, id: string, name: string) => {
      if (IMAGE_EXT_RE.test(name)) {
        images.push({ id, name })
        return ''
      }
      return match
    }).trim()
    if (images.length) {
      const parts: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      > = []
      if (cleanedText) parts.push({ type: 'text', text: cleanedText })
      for (const img of images) {
        const data = loadAttachment(img.id)
        if (!data) continue
        const mime = data.mime || imageMime(img.name)
        const dataUrl = `data:${mime};base64,${data.buffer.toString('base64')}`
        parts.push({ type: 'image_url', image_url: { url: dataUrl } })
      }
      return { role: 'user', content: parts as any }
    }
  }
  return { role: 'user', content: t.content }
}
