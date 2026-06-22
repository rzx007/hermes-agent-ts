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

test('provider 抛错时产出 error 事件', async () => {
  const provider: Provider = {
    name: 'mock',
    // eslint-disable-next-line require-yield
    async *complete() { throw new Error('网络炸了'); },
    async aggregate(): Promise<CompletionResult> { return { content: null, toolCalls: [], finishReason: 'stop' }; },
  };
  const { db, deps } = makeDeps(provider);
  const s = db.createSession();
  const events: LoopEvent[] = [];
  for await (const e of runConversation(deps, s.id, 'x', { cwd: '/', logger: createLogger('t') })) events.push(e);
  const last = events.at(-1);
  expect(last?.type).toBe('error');
  expect(last && last.type === 'error' ? last.error : '').toContain('网络炸了');
});

test('单轮内多个工具调用按序执行并落库', async () => {
  const provider = scriptedProvider([
    [
      { toolCallDelta: { index: 0, id: 'c1', name: 'read_file', argsDelta: '{"path":"a"}' } },
      { toolCallDelta: { index: 1, id: 'c2', name: 'read_file', argsDelta: '{"path":"b"}' } },
    ],
    [{ contentDelta: '两个都读完了' }],
  ]);
  const { db, deps } = makeDeps(provider);
  const s = db.createSession();
  const events: LoopEvent[] = [];
  for await (const e of runConversation(deps, s.id, '读 a 和 b', { cwd: '/', logger: createLogger('t') })) events.push(e);
  const toolCalls = events.filter((e) => e.type === 'tool_call');
  const toolResults = events.filter((e) => e.type === 'tool_result');
  expect(toolCalls.length).toBe(2);
  expect(toolResults.length).toBe(2);
  expect(events.at(-1)?.type).toBe('turn_done');
  // user + assistant(2 toolcalls) + tool + tool + assistant(final) = 5 条
  expect(db.getMessages(s.id).length).toBe(5);
});

test('已中止的 signal 立即结束当前轮', async () => {
  const provider = scriptedProvider([[{ contentDelta: 'hi' }]]);
  const { db, deps } = makeDeps(provider);
  const s = db.createSession();
  const ac = new AbortController();
  ac.abort();
  const events: LoopEvent[] = [];
  for await (const e of runConversation(deps, s.id, 'x', { cwd: '/', logger: createLogger('t'), signal: ac.signal })) events.push(e);
  expect(events.at(-1)?.type).toBe('error');
});

test('toolNames 限定暴露给 provider 的工具', async () => {
  const seen: string[][] = [];
  const provider: Provider = {
    name: 'mock',
    async *complete(req) { seen.push((req.tools ?? []).map((t) => t.name)); yield { contentDelta: 'ok' }; },
    async aggregate(): Promise<CompletionResult> { return { content: 'ok', toolCalls: [], finishReason: 'stop' }; },
  };
  const { db, deps } = makeDeps(provider);
  // makeDeps 注册了 read_file;再注册一个 terminal 以便区分
  deps.registry.register({ name: 'terminal', description: 't', toolset: 'terminal', schema: z.object({}), handler: async () => 'x' });
  // 用展开构造带 toolNames 的新 deps(makeDeps 返回的是 inferred 字面量,不能直接赋 toolNames)
  const filtered = { ...deps, toolNames: ['read_file'] };
  const s = db.createSession();
  for await (const _ of runConversation(filtered, s.id, 'hi', { cwd: '/', logger: createLogger('t') })) { /* drain */ }
  expect(seen[0]).toEqual(['read_file']);
});

test('注入 deps.memory 后 system 消息含记忆内容', async () => {
  const seen: import('@hermes/core').Message[][] = [];
  const provider: Provider = {
    name: 'mock',
    async *complete(req) { seen.push(req.messages); yield { contentDelta: 'ok' }; },
    async aggregate(): Promise<CompletionResult> { return { content: 'ok', toolCalls: [], finishReason: 'stop' }; },
  };
  const { db, deps } = makeDeps(provider);
  const fakeMemory = { render: () => '════ MEMORY ════\n记得喜欢 pnpm' } as unknown as import('@hermes/core').MemoryStore;
  const filtered = { ...deps, memory: fakeMemory };
  const s = db.createSession();
  for await (const _ of runConversation(filtered, s.id, 'hi', { cwd: '/', logger: createLogger('t') })) { /* drain */ }
  const sys = seen[0]!.find((m) => m.role === 'system');
  expect(sys?.content).toContain('记得喜欢 pnpm');
});
