import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, createLogger } from '@hermes/core';
import { memoryTool } from './memory.js';

let dir: string;
let mem: MemoryStore;
const ctx = () => ({ cwd: process.cwd(), logger: createLogger('test'), memory: mem });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hermes-memtool-')); mem = new MemoryStore(dir); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('add 经工具落盘', async () => {
  const out = await memoryTool.handler({ action: 'add', target: 'memory', content: '喜欢 pnpm' }, ctx());
  expect(mem.getEntries('memory')).toEqual(['喜欢 pnpm']);
  expect(out).toContain('memory');
});

test('add 缺 content → 错误', async () => {
  await expect(memoryTool.handler({ action: 'add', target: 'memory' }, ctx())).rejects.toThrow();
});

test('replace 经工具', async () => {
  mem.add('user', '喜欢 C#');
  await memoryTool.handler({ action: 'replace', target: 'user', oldText: 'C#', content: 'Rust' }, ctx());
  expect(mem.getEntries('user')).toEqual(['喜欢 Rust']);
});

test('replace 缺 oldText → 错误', async () => {
  await expect(memoryTool.handler({ action: 'replace', target: 'user', content: 'x' }, ctx())).rejects.toThrow();
});

test('remove 经工具', async () => {
  mem.add('memory', 'old fact');
  await memoryTool.handler({ action: 'remove', target: 'memory', oldText: 'old fact' }, ctx());
  expect(mem.getEntries('memory')).toEqual([]);
});

test('无 ctx.memory → 返回不可用字符串(不抛)', async () => {
  const out = await memoryTool.handler(
    { action: 'add', target: 'memory', content: 'x' },
    { cwd: process.cwd(), logger: createLogger('test') },
  );
  expect(out).toContain('不可用');
});
