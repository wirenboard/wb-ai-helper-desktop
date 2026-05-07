import OpenAI from 'openai'
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions.mjs'
import type { Stream } from 'openai/streaming.mjs'

export type ChatTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; createdAt?: number; toolCalls?: AssistantToolCall[]; tokensPrompt?: number; tokensCompletion?: number; tokensCached?: number; tokensCost?: number }
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
  | { type: 'done'; finish_reason: string | null }
  | { type: 'error'; message: string }

export class LlmClient {
  private client: OpenAI
  readonly model: string

  constructor(opts: { apiKey: string; baseURL?: string; model?: string; llmProxy?: string; llmProxyUser?: string; llmProxyPassword?: string; tlsInsecure?: boolean; caCert?: string; apiFormat?: 'openai' }) {
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
    },
  ): AsyncGenerator<StreamEvent> {
    const maxTurns = opts?.maxTurns ?? 8
    const activeModel = opts?.modelOverride?.trim() || this.model
    const temperature = typeof opts?.temperature === 'number' && Number.isFinite(opts.temperature)
      ? opts.temperature
      : undefined
    const messages = history.map(toApi)
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
          content: '⚠ ПОСЛЕДНЯЯ ИТЕРАЦИЯ АГЕНТНОГО ЦИКЛА. НЕ вызывай инструменты. Дай финальный ответ на основе уже собранной информации.',
        })
      }
      const messagesForApi: ChatCompletionMessageParam[] = messages.length > 0
        ? [messages[0]!, ...injected, ...messages.slice(1)]
        : [...injected]

      let stream: Stream<ChatCompletionChunk>
      try {
        stream = await this.client.chat.completions.create({
          model: activeModel,
          messages: messagesForApi,
          tools: isLastTurn ? undefined : (tools.length ? tools : undefined),
          stream: true,
          stream_options: { include_usage: true },
          ...(temperature !== undefined ? { temperature } : {}),
        })
      } catch (e: any) {
        yield { type: 'error', message: formatLlmError(e) }
        return
      }

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
            // Server-side billing in the provider's currency. Different
            // gateways use different field names: VseGPT/OpenRouter — total_cost
            // (USD), aitunnel — cost_rub (RUB). Same channel — frontend sees
            // it as tokensCost and pairs it with the active provider currency.
            const u = chunk.usage as { total_cost?: number; cost_rub?: number }
            const c = u.total_cost ?? u.cost_rub
            if (typeof c === 'number') totalCost += c
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
        messages.push({ role: 'system', content: `Чекпоинт — итог предыдущего этапа:\n${summary}` })
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
 * Превращает ошибку OpenAI SDK / fetch в человекочитаемое сообщение.
 * Покрывает специфичные коды AITunnel ([docs](https://docs.aitunnel.ru/api/errors.html)),
 * ровно те же коды у других OpenAI-совместимых шлюзов трактуются так же.
 *
 * Структура ответа AITunnel: `{ error: { code: number, message: string, metadata? } }`,
 * у OpenAI — `{ error: { message, type, code? } }`. Достаём оба варианта.
 */
export function formatLlmError(e: unknown): string {
  const err = e as { status?: number; message?: string; error?: any; cause?: any }
  // OpenAI SDK кладёт parsed body в `err.error`
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
      // У AITunnel 402 = недостаточно средств; meta может содержать `provider_name`
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

function toApi(t: ChatTurn): ChatCompletionMessageParam {
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
  return { role: 'user', content: t.content }
}
