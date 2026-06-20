import { test, expect } from 'vitest';
import { aggregateChunks } from './openai-compatible.js';
import type { CompletionChunk } from './provider.js';

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
