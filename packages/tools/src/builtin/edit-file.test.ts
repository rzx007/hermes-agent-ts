import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editFileTool } from './edit-file.js';
import { createLogger } from '@hermes/core';

let dir: string;
const ctx = () => ({ cwd: dir, logger: createLogger('test') });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hermes-edit-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('唯一匹配替换成功', async () => {
  writeFileSync(join(dir, 'a.txt'), 'hello world');
  const out = await editFileTool.handler({ path: 'a.txt', oldString: 'world', newString: 'there' }, ctx());
  expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('hello there');
  expect(out).toContain('1');
});

test('未找到 oldString 抛错', async () => {
  writeFileSync(join(dir, 'a.txt'), 'hello');
  await expect(editFileTool.handler({ path: 'a.txt', oldString: 'xyz', newString: 'q' }, ctx())).rejects.toThrow();
});

test('oldString 不唯一且未设 replaceAll 抛错', async () => {
  writeFileSync(join(dir, 'a.txt'), 'a a a');
  await expect(editFileTool.handler({ path: 'a.txt', oldString: 'a', newString: 'b' }, ctx())).rejects.toThrow();
});

test('replaceAll 替换全部', async () => {
  writeFileSync(join(dir, 'a.txt'), 'a a a');
  const out = await editFileTool.handler({ path: 'a.txt', oldString: 'a', newString: 'b', replaceAll: true }, ctx());
  expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('b b b');
  expect(out).toContain('3');
});
