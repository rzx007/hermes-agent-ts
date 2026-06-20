import { v4 as uuid } from 'uuid';
import type { SessionDB, Message } from '@hermes/core';
import type { Provider, CompletionChunk } from '@hermes/providers';
import type { ToolRegistry, ToolContext } from '@hermes/tools';
import type { LoopEvent } from './events.js';
import { buildSystemPrompt } from './system-prompt.js';

export interface LoopDeps {
  db: SessionDB;
  provider: Provider;
  registry: ToolRegistry;
  model: string;
  maxIterations: number;
}

export async function* runConversation(
  deps: LoopDeps,
  sessionId: string,
  userText: string,
  ctx: ToolContext,
): AsyncIterable<LoopEvent> {
  const { db, provider, registry, model, maxIterations } = deps;

  // 1. 构建消息：system + 历史 + 新 user
  const history = db.getMessages(sessionId);
  const messages: Message[] = [
    { role: 'system', content: buildSystemPrompt(ctx.cwd) },
    ...history,
    { role: 'user', content: userText },
  ];
  db.appendMessage(sessionId, { role: 'user', content: userText });

  const tools = registry.getSchemas();

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // a. 流式调模型：边收边发 assistant_delta，同时缓存 chunk 供聚合
      const captured: CompletionChunk[] = [];
      for await (const chunk of provider.complete({ model, messages, tools, signal: ctx.signal })) {
        captured.push(chunk);
        if (chunk.contentDelta) yield { type: 'assistant_delta', text: chunk.contentDelta };
      }
      // b. 聚合成完整结果（stream 只消费一次，这里回放缓存的 chunk）
      const result = await provider.aggregate((async function* () { for (const c of captured) yield c; })());

      // c. 落库 assistant 消息
      const assistantMsg: Message = {
        role: 'assistant',
        content: result.content,
        toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
      };
      messages.push(assistantMsg);
      db.appendMessage(sessionId, assistantMsg);

      // d. 无工具调用 → 结束
      if (result.toolCalls.length === 0) {
        yield { type: 'turn_done', result };
        return;
      }

      // e. 执行每个工具调用
      for (const call of result.toolCalls) {
        yield { type: 'tool_call', name: call.name, args: call.arguments };
        const output = await registry.call(call.name, call.arguments, ctx);
        yield { type: 'tool_result', name: call.name, output };
        const toolMsg: Message = {
          role: 'tool', content: output,
          toolCallId: call.id || uuid(), name: call.name,
        };
        messages.push(toolMsg);
        db.appendMessage(sessionId, toolMsg);
      }
    }
    yield { type: 'error', error: `达到最大工具迭代次数（${maxIterations}），已停止。` };
  } catch (e) {
    yield { type: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}
