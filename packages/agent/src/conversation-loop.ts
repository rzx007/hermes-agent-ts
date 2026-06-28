import { v4 as uuid } from 'uuid';
import type { SessionDB, Message, MemoryStore, SkillStore } from '@hermes/core';
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
  toolNames?: string[];
  memory?: MemoryStore;
  skills?: SkillStore;
}
/**
 * runConversation — 单次用户输入的 ReAct / tool-use 循环
 *
 *  ┌─────────────────────────────────────────────────────────────┐
 *  │  准备阶段（循环外，只做一次）                                  │
 *  │  history ← DB    messages ← system + history + user          │
 *  │  user 消息落库    tools ← registry.getSchemas()              │
 *  └──────────────────────────┬──────────────────────────────────┘
 *                             │
 *                             ▼
 *  ┌─────────────────────────────────────────────────────────────┐
 *  │  iteration loop  (0 .. maxIterations-1)                    │
 *  │                                                             │
 *  │   messages + tools                                          │
 *  │        │                                                    │
 *  │        ▼                                                    │
 *  │   provider.complete()  ──stream──►  yield assistant_delta   │
 *  │        │                         (CLI 实时打字)              │
 *  │        └── captured[] 缓存所有 chunk                        │
 *  │                │                                            │
 *  │                ▼                                            │
 *  │        provider.aggregate(captured) → CompletionResult      │
 *  │                │                                            │
 *  │                ▼                                            │
 *  │        assistant 消息 → messages[] + DB                     │
 *  │                │                                            │
 *  │        ┌───────┴───────┐                                    │
 *  │        │ toolCalls?    │                                    │
 *  │        ▼               ▼                                    │
 *  │      空              非空                                    │
 *  │        │               │                                    │
 *  │        ▼               ▼                                    │
 *  │   turn_done         for each call:                          │
 *  │   return            yield tool_call                         │
 *  │                     registry.call()                       │
 *  │                     yield tool_result                       │
 *  │                     tool 消息 → messages[] + DB             │
 *  │                           │                                 │
 *  │                           └──► 下一轮 iteration             │
 *  └─────────────────────────────────────────────────────────────┘
 *                             │
 *              超过 maxIterations → yield error
 *              异常 / abort      → yield error
 *
 * LoopEvent 类型:
 *   assistant_delta | tool_call | tool_result | turn_done | error
 */

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
    { role: 'system', content: buildSystemPrompt(ctx.cwd, deps.memory?.render(), deps.skills?.renderIndex()) },
    ...history,
    { role: 'user', content: userText },
  ];
  db.appendMessage(sessionId, { role: 'user', content: userText });

  const tools = registry.getSchemas(deps.toolNames);

  try {
    let toolIterations = 0; // 统计发起过工具调用的轮数(纯文本收尾轮不计;一轮内 N 个并行调用算 1)
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (ctx.signal?.aborted) { yield { type: 'error', error: '已中断' }; return; }
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
        yield { type: 'turn_done', result, iterations: toolIterations };
        return;
      }
      toolIterations++;

      // e. 执行每个工具调用
      for (const call of result.toolCalls) {
        if (ctx.signal?.aborted) { yield { type: 'error', error: '已中断' }; return; }
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
/**
[system]
[user]           ← 本次输入
[assistant]      ← 第1轮：决定调 read_file
[tool]           ← read_file 结果
[assistant]      ← 第2轮：决定调 write_file
[tool]           ← write_file 结果
[assistant]      ← 第3轮：纯文本回答，toolCalls=[]
                 → turn_done，等待下一条 user 输入
*/