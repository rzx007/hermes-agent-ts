import { test, expect } from 'vitest';
import { SessionDB, createLogger } from '@hermes/core';
import { ToolRegistry } from '@hermes/tools';
import { z } from 'zod';
import type { Provider, CompletionChunk, CompletionResult } from '@hermes/providers';
import { runConversation } from './conversation-loop.js';
import type { LoopEvent } from './events.js';

// mock provider：第一轮发 tool_call，第二轮发纯文本
function scriptedProvider(scripts: CompletionChunk[][]): Provider {
  let turn = 0;
  return {
    name: 'mock',
    async *complete() { for (const c of scripts[turn] ?? []) yield c; turn++; },
    async aggregate(chunks): Promise<CompletionResult> {
      let content = ''; const calls = new Map<number, any>();
      for await (const c of chunks) {
        if (c.contentDelta) content += c.contentDelta;
        if (c.toolCallDelta) {
          const d = c.toolCallDelta; const cur = calls.get(d.index) ?? { id: '', name: '', arguments: '' };
          if (d.id) cur.id = d.id; if (d.name) cur.name = d.name; if (d.argsDelta) cur.arguments += d.argsDelta;
          calls.set(d.index, cur);
        }
      }
      const toolCalls = [...calls.values()];
      return { content: content || null, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop' };
    },
  };
}

function makeDeps(provider: Provider) {
  const db = new SessionDB(':memory:');
  const registry = new ToolRegistry();
  registry.register({
    name: 'read_file', description: 'read', toolset: 'core',
    schema: z.object({ path: z.string() }),
    handler: async (a) => `内容 of ${a.path}`,
  });
  return { db, registry, deps: { db, provider, registry, model: 'mock', maxIterations: 10 } };
}

test('单轮纯文本：无工具调用直接结束', async () => {
  const provider = scriptedProvider([[{ contentDelta: '你好' }]]);
  const { db, deps } = makeDeps(provider);
  const s = db.createSession();
  const events: LoopEvent[] = [];
  for await (const e of runConversation(deps, s.id, 'hi', { cwd: '/', logger: createLogger('t') })) events.push(e);

  expect(events.some((e) => e.type === 'assistant_delta')).toBe(true);
  expect(events.at(-1)?.type).toBe('turn_done');
  // 落库：user + assistant = 2 条
  expect(db.getMessages(s.id).length).toBe(2);
});

test('工具调用轮：执行工具后再产出最终回答', async () => {
  const provider = scriptedProvider([
    [{ toolCallDelta: { index: 0, id: 'c1', name: 'read_file', argsDelta: '{"path":"a"}' } }],
    [{ contentDelta: '文件读完了' }],
  ]);
  const { db, deps } = makeDeps(provider);
  const s = db.createSession();
  const events: LoopEvent[] = [];
  for await (const e of runConversation(deps, s.id, '读 a', { cwd: '/', logger: createLogger('t') })) events.push(e);

  expect(events.some((e) => e.type === 'tool_call' && e.name === 'read_file')).toBe(true);
  expect(events.some((e) => e.type === 'tool_result')).toBe(true);
  expect(events.at(-1)?.type).toBe('turn_done');
  // user + assistant(toolcall) + tool + assistant(final) = 4 条
  expect(db.getMessages(s.id).length).toBe(4);
});

test('超过 maxIterations 产出 error', async () => {
  const loopChunk: CompletionChunk[] = [{ toolCallDelta: { index: 0, id: 'c1', name: 'read_file', argsDelta: '{"path":"a"}' } }];
  const provider: Provider = {
    name: 'mock', async *complete() { for (const c of loopChunk) yield c; },
    async aggregate() { return { content: null, toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }], finishReason: 'tool_calls' }; },
  };
  const { db, deps } = makeDeps(provider);
  deps.maxIterations = 2;
  const s = db.createSession();
  const events: LoopEvent[] = [];
  for await (const e of runConversation(deps, s.id, 'x', { cwd: '/', logger: createLogger('t') })) events.push(e);
  expect(events.at(-1)?.type).toBe('error');
});
