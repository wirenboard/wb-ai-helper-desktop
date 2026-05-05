import OpenAI from 'openai'
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions.mjs'
import type { Stream } from 'openai/streaming.mjs'

export type ChatTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: AssistantToolCall[]; tokensPrompt?: number; tokensCompletion?: number }
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
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'done'; finish_reason: string | null }
  | { type: 'error'; message: string }

export class LlmClient {
  private client: OpenAI
  readonly model: string

  constructor(opts: { apiKey: string; baseURL?: string; model?: string }) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL })
    this.model = opts.model ?? 'gpt-4.1-mini'
  }

  /** Run an agent loop streaming events until model stops requesting tools. */
  async *runAgent(
    history: ChatTurn[],
    tools: ChatCompletionTool[],
    runTool: (name: string, args: string) => Promise<string>,
    opts?: { maxTurns?: number; signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent> {
    const maxTurns = opts?.maxTurns ?? 8
    const messages = history.map(toApi)
    let totalPromptTokens = 0
    let totalCompletionTokens = 0

    for (let turn = 0; turn < maxTurns; turn++) {
      let stream: Stream<ChatCompletionChunk>
      try {
        stream = await this.client.chat.completions.create({
          model: this.model,
          messages,
          tools: tools.length ? tools : undefined,
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
            totalPromptTokens += chunk.usage.prompt_tokens
            totalCompletionTokens += chunk.usage.completion_tokens
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
          yield { type: 'usage', promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens }
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
    }

    if (totalPromptTokens || totalCompletionTokens) {
      yield { type: 'usage', promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens }
    }
    yield { type: 'done', finish_reason: 'max_turns' }
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
