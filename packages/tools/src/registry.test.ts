import { test, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from './registry.js';
import { createLogger } from '@hermes/core';

const ctx = { cwd: process.cwd(), logger: createLogger('test') };

function makeRegistry() {
  const r = new ToolRegistry();
  r.register({
    name: 'echo', description: 'echo back', toolset: 'core',
    schema: z.object({ text: z.string() }),
    handler: async (a) => `echoed: ${a.text}`,
  });
  return r;
}

test('getSchemas 输出 JSON Schema', () => {
  const schemas = makeRegistry().getSchemas();
  expect(schemas[0]!.name).toBe('echo');
  expect(schemas[0]!.parameters).toMatchObject({ type: 'object' });
});

test('call 正常执行返回字符串', async () => {
  const out = await makeRegistry().call('echo', '{"text":"hi"}', ctx);
  expect(out).toBe('echoed: hi');
});

test('call 在 JSON 解析失败时返回错误文本（不抛）', async () => {
  const out = await makeRegistry().call('echo', '{bad json', ctx);
  expect(out.toLowerCase()).toContain('error');
});

test('call 在 Zod 校验失败时返回错误文本（不抛）', async () => {
  const out = await makeRegistry().call('echo', '{"text":123}', ctx);
  expect(out.toLowerCase()).toContain('error');
});

test('call 未知工具返回错误文本', async () => {
  const out = await makeRegistry().call('nope', '{}', ctx);
  expect(out.toLowerCase()).toContain('error');
});

test('call 在 handler 抛错时返回错误文本（含原因）', async () => {
  const r = new ToolRegistry();
  r.register({
    name: 'boom', description: 'throws', toolset: 'core',
    schema: z.object({}),
    handler: async () => { throw new Error('炸了'); },
  });
  const out = await r.call('boom', '{}', ctx);
  expect(out).toContain('Error');
  expect(out).toContain('炸了');
});

test('call 在 handler 抛非 Error 值时也返回错误文本', async () => {
  const r = new ToolRegistry();
  r.register({
    name: 'boom2', description: 'throws string', toolset: 'core',
    schema: z.object({}),
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    handler: async () => { throw 'plain string error'; },
  });
  const out = await r.call('boom2', '{}', ctx);
  expect(out).toContain('Error');
  expect(out).toContain('plain string error');
});
