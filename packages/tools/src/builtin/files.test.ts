import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { createLogger } from '@hermes/core';

let dir: string;
const ctx = () => ({ cwd: dir, logger: createLogger('test') });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hermes-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('write_file 写入并 read_file 带行号读回', async () => {
  await writeFileTool.handler({ path: 'a.txt', content: 'l1\nl2' }, ctx());
  const out = await readFileTool.handler({ path: 'a.txt' }, ctx());
  expect(out).toContain('1');
  expect(out).toContain('l1');
  expect(out).toContain('l2');
});

test('write_file 自动建父目录', async () => {
  await writeFileTool.handler({ path: 'sub/dir/b.txt', content: 'x' }, ctx());
  expect(readFileSync(join(dir, 'sub/dir/b.txt'), 'utf8')).toBe('x');
});

test('read_file 不存在的文件由 handler 抛错（注册后由 registry 捕获）', async () => {
  await expect(readFileTool.handler({ path: 'nope.txt' }, ctx())).rejects.toThrow();
});
