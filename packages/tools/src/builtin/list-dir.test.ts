import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDirTool } from './list-dir.js';
import { createLogger } from '@hermes/core';

let dir: string;
const ctx = () => ({ cwd: dir, logger: createLogger('test') });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-ls-'));
  writeFileSync(join(dir, 'file.txt'), 'x');
  mkdirSync(join(dir, 'sub'));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('列出条目,目录带尾随 /', async () => {
  const out = await listDirTool.handler({}, ctx());
  expect(out).toContain('file.txt');
  expect(out).toContain('sub/');
});

test('指定子路径', async () => {
  writeFileSync(join(dir, 'sub', 'inner.txt'), 'y');
  const out = await listDirTool.handler({ path: 'sub' }, ctx());
  expect(out).toContain('inner.txt');
});

test('路径不存在抛错', async () => {
  await expect(listDirTool.handler({ path: 'nope' }, ctx())).rejects.toThrow();
});
