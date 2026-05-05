import OpenAI from 'openai'
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions.mjs'
import type { Stream } from 'openai/streaming.mjs'

export type ChatTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: AssistantToolCall[]; tokensPrompt?: number; tokensCompletion?: number; tokensCached?: number; tokensCost?: number }
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
  | { type: 'usage'; promptTokens?: number; completionTokens?: number; cachedTokens?: number; totalCost?: number }
  | { type: 'done'; finish_reason: string | null }
  | { type: 'error'; message: string }

export class LlmClient {
  private client: OpenAI
  readonly model: string

  constructor(opts: { apiKey: string; baseURL?: string; model?: string; llmProxy?: string; llmProxyUser?: string; llmProxyPassword?: string; tlsInsecure?: boolean }) {
    const needCustomFetch = opts.llmProxy || opts.tlsInsecure
    const proxyUrl = opts.llmProxy ? buildProxyUrl(opts.llmProxy, opts.llmProxyUser, opts.llmProxyPassword) : undefined
    const fetchFn = needCustomFetch
      ? (url: string | URL, init?: RequestInit) => {
          const extra: Record<string, unknown> = {}
          if (proxyUrl) extra['proxy'] = proxyUrl
          if (opts.tlsInsecure) extra['tls'] = { rejectUnauthorized: false }
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
    },
  ): AsyncGenerator<StreamEvent> {
    const maxTurns = opts?.maxTurns ?? 8
    const messages = history.map(toApi)
    let totalPromptTokens = 0
    let totalCompletionTokens = 0
    let totalCachedTokens = 0
    let totalCost = 0  // VseGPT/OpenRouter style — provider-reported cost in their currency

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
          model: this.model,
          messages: messagesForApi,
          tools: isLastTurn ? undefined : (tools.length ? tools : undefined),
          stream: true,
          stream_options: { include_usage: true },
        })
      } catch (e: any) {
        yield { type: 'error', message: `LLM error: ${e?.message ?? String(e)}` }
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
            // VseGPT extension: server-side billing in RUB
            const c = (chunk.usage as { total_cost?: number }).total_cost
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
