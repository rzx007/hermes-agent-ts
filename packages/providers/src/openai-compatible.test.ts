import { test, expect } from 'vitest';
import { aggregateChunks, toOpenAIMessages, toOpenAITools } from './openai-compatible.js';
import type { CompletionChunk } from './provider.js';
import type { Message } from '@hermes/core';

async function* gen(chunks: CompletionChunk[]) { for (const c of chunks) yield c; }

test('聚合纯文本增量', async () => {
  const r = await aggregateChunks(gen([
    { contentDelta: 'Hel' }, { contentDelta: 'lo' },
  ]));
  expect(r.content).toBe('Hello');
  expect(r.toolCalls).toEqual([]);
});

test('按 index 累积分片的 tool_call', async () => {
  const r = await aggregateChunks(gen([
    { toolCallDelta: { index: 0, id: 'c1', name: 'read_file' } },
    { toolCallDelta: { index: 0, argsDelta: '{"pa' } },
    { toolCallDelta: { index: 0, argsDelta: 'th":"a"}' } },
  ]));
  expect(r.toolCalls).toEqual([{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }]);
});

test('多个并行 tool_call 按 index 分别累积', async () => {
  const r = await aggregateChunks(gen([
    { toolCallDelta: { index: 0, id: 'c1', name: 'read_file', argsDelta: '{}' } },
    { toolCallDelta: { index: 1, id: 'c2', name: 'write_file', argsDelta: '{}' } },
  ]));
  expect(r.toolCalls.map((t) => t.name)).toEqual(['read_file', 'write_file']);
});

test('toOpenAIMessages 转换 assistant + tool_calls', () => {
  const msgs: Message[] = [
    { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }] },
  ];
  const out = toOpenAIMessages(msgs) as any[];
  expect(out[0].role).toBe('assistant');
  expect(out[0].tool_calls[0]).toMatchObject({ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } });
});

test('toOpenAIMessages 转换 tool 消息为 tool_call_id', () => {
  const msgs: Message[] = [{ role: 'tool', content: 'result', toolCallId: 'c1', name: 'read_file' }];
  const out = toOpenAIMessages(msgs) as any[];
  expect(out[0]).toMatchObject({ role: 'tool', content: 'result', tool_call_id: 'c1' });
});

test('toOpenAIMessages 对缺失 toolCallId 的 tool 消息抛错', () => {
  const msgs: Message[] = [{ role: 'tool', content: 'x' }];
  expect(() => toOpenAIMessages(msgs)).toThrow(/toolCallId/);
});

test('toOpenAITools 空数组返回 undefined，非空映射为 function 格式', () => {
  expect(toOpenAITools([])).toBeUndefined();
  expect(toOpenAITools(undefined)).toBeUndefined();
  const out = toOpenAITools([{ name: 'echo', description: 'd', parameters: { type: 'object' } }]);
  expect(out?.[0]).toMatchObject({ type: 'function', function: { name: 'echo', description: 'd' } });
});

test('aggregateChunks 从 chunk 读取 finishReason 与 usage', async () => {
  async function* g(cs: CompletionChunk[]) { for (const c of cs) yield c; }
  const r = await aggregateChunks(g([
    { contentDelta: 'hi' },
    { finishReason: 'stop' },
    { usage: { promptTokens: 10, completionTokens: 5 } },
  ]));
  expect(r.finishReason).toBe('stop');
  expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
});
