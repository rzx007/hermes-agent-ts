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
