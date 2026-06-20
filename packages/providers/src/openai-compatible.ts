import OpenAI from 'openai';
import type {
  Provider, CompletionRequest, CompletionChunk, CompletionResult, ToolSchema,
} from './provider.js';
import type { Message } from '@hermes/core';

export interface OpenAICompatibleOpts {
  name: string;
  apiKey: string;
  baseURL: string;
}

// 纯函数：把流式增量聚合成完整结果（核心，单测覆盖）
export async function aggregateChunks(
  chunks: AsyncIterable<CompletionChunk>,
): Promise<CompletionResult> {
  let content = '';
  let finishReason: string | undefined;
  let usage: CompletionResult['usage'];
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  for await (const c of chunks) {
    if (c.contentDelta) content += c.contentDelta;
    if (c.finishReason) finishReason = c.finishReason;
    if (c.usage) usage = c.usage;
    if (c.toolCallDelta) {
      const d = c.toolCallDelta;
      const cur = calls.get(d.index) ?? { id: '', name: '', arguments: '' };
      if (d.id) cur.id = d.id;
      if (d.name) cur.name = d.name;
      if (d.argsDelta !== undefined) cur.arguments += d.argsDelta;
      calls.set(d.index, cur);
    }
  }
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return {
    content: content || null,
    toolCalls,
    finishReason: finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'),
    usage,
  };
}

export function toOpenAIMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((t) => ({
              id: t.id, type: 'function' as const,
              function: { name: t.name, arguments: t.arguments },
            })) }
          : {}),
      };
    }
    if (m.role === 'tool') {
      if (!m.toolCallId) throw new Error('tool message is missing toolCallId');
      return { role: 'tool', content: m.content ?? '', tool_call_id: m.toolCallId };
    }
    return { role: m.role, content: m.content ?? '' } as OpenAI.ChatCompletionMessageParam;
  });
}

export function toOpenAITools(tools?: ToolSchema[]): OpenAI.ChatCompletionTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> },
  }));
}

export class OpenAICompatibleProvider implements Provider {
  readonly name: string;
  private client: OpenAI;

  constructor(opts: OpenAICompatibleOpts) {
    this.name = opts.name;
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  }

  async *complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    const stream = await this.client.chat.completions.create({
      model: req.model,
      messages: toOpenAIMessages(req.messages),
      tools: toOpenAITools(req.tools),
      stream: true,
      stream_options: { include_usage: true },
    }, { signal: req.signal });

    for await (const part of stream) {
      const choice = part.choices[0];
      if (choice?.delta?.content) yield { contentDelta: choice.delta.content };
      for (const tc of choice?.delta?.tool_calls ?? []) {
        if (tc.id || tc.function?.name || tc.function?.arguments !== undefined) {
          yield {
            toolCallDelta: {
              index: tc.index,
              id: tc.id,
              name: tc.function?.name,
              argsDelta: tc.function?.arguments,
            },
          };
        }
      }
      if (choice?.finish_reason) yield { finishReason: choice.finish_reason };
      if (part.usage) {
        yield {
          usage: {
            promptTokens: part.usage.prompt_tokens,
            completionTokens: part.usage.completion_tokens,
          },
        };
      }
    }
  }

  aggregate(chunks: AsyncIterable<CompletionChunk>): Promise<CompletionResult> {
    return aggregateChunks(chunks);
  }
}
