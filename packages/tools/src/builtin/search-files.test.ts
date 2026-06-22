import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchFilesTool } from './search-files.js';
import { createLogger } from '@hermes/core';

let dir: string;
const ctx = () => ({ cwd: dir, logger: createLogger('test') });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-search-'));
  writeFileSync(join(dir, 'a.ts'), 'const foo = 1;\nconst bar = 2;');
  writeFileSync(join(dir, 'b.txt'), 'foo appears here');
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'c.ts'), 'foo in node_modules');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('content 模式返回 路径:行号: 匹配行', async () => {
  const out = await searchFilesTool.handler({ pattern: 'foo' }, ctx());
  expect(out).toContain('a.ts');
  expect(out).toMatch(/a\.ts:1:/);
  expect(out).toContain('foo');
});

test('content 模式忽略 node_modules', async () => {
  const out = await searchFilesTool.handler({ pattern: 'foo' }, ctx());
  expect(out).not.toContain('node_modules');
});

test('content 模式 glob 限定文件范围', async () => {
  const out = await searchFilesTool.handler({ pattern: 'foo', glob: '**/*.ts' }, ctx());
  expect(out).toContain('a.ts');
  expect(out).not.toContain('b.txt');
});

test('filename 模式返回路径列表', async () => {
  const out = await searchFilesTool.handler({ pattern: '**/*.ts', mode: 'filename' }, ctx());
  expect(out).toContain('a.ts');
  expect(out).not.toContain('b.txt');
});

test('无匹配返回提示', async () => {
  const out = await searchFilesTool.handler({ pattern: 'zzzznomatch_xyzqq' }, ctx());
  expect(out).toContain('无匹配');
});

test('无效正则抛错', async () => {
  await expect(searchFilesTool.handler({ pattern: '(' }, ctx())).rejects.toThrow();
});

test('content 模式跳过 dotfile', async () => {
  writeFileSync(join(dir, '.env'), 'SECRET=foo');
  const out = await searchFilesTool.handler({ pattern: 'foo' }, ctx());
  expect(out).not.toContain('.env');
});
