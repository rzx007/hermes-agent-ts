import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './memory-store.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hermes-mem-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('add 追加条目并落盘', () => {
  const m = new MemoryStore(dir);
  m.add('memory', '喜欢用 pnpm');
  expect(m.getEntries('memory')).toEqual(['喜欢用 pnpm']);
  expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('喜欢用 pnpm');
});

test('add 多条用 § 分隔落盘', () => {
  const m = new MemoryStore(dir);
  m.add('memory', 'a');
  m.add('memory', 'b');
  expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('a\n§\nb');
});

test('user target 写 USER.md', () => {
  const m = new MemoryStore(dir);
  m.add('user', '用户叫 Danovan');
  expect(readFileSync(join(dir, 'USER.md'), 'utf8')).toBe('用户叫 Danovan');
});

test('render 含条目;空 store render 为空', () => {
  const m = new MemoryStore(dir);
  expect(m.render()).toBe('');
  m.add('memory', 'foo');
  expect(m.render()).toContain('foo');
  expect(m.render()).toContain('MEMORY');
});

test('新 MemoryStore 从同目录加载条目(持久化)', () => {
  new MemoryStore(dir).add('memory', 'persisted');
  const m2 = new MemoryStore(dir);
  expect(m2.getEntries('memory')).toEqual(['persisted']);
});

test('add 超字数上限 → throw 且不落盘', () => {
  const m = new MemoryStore(dir);
  m.add('user', 'x');
  const big = 'y'.repeat(1375);
  expect(() => m.add('user', big)).toThrow();
  expect(m.getEntries('user')).toEqual(['x']);
  expect(readFileSync(join(dir, 'USER.md'), 'utf8')).toBe('x');
});

test('replace 唯一替换', () => {
  const m = new MemoryStore(dir);
  m.add('memory', '喜欢 C#');
  m.replace('memory', 'C#', 'Rust');
  expect(m.getEntries('memory')).toEqual(['喜欢 Rust']);
});

test('replace 未找到 → throw', () => {
  const m = new MemoryStore(dir);
  m.add('memory', 'a');
  expect(() => m.replace('memory', 'zzz', 'b')).toThrow();
});

test('replace 多匹配 → throw', () => {
  const m = new MemoryStore(dir);
  m.add('memory', 'foo one');
  m.add('memory', 'foo two');
  expect(() => m.replace('memory', 'foo', 'bar')).toThrow();
});

test('replace 含 $ 的替换按字面量', () => {
  const m = new MemoryStore(dir);
  m.add('memory', 'price TOKEN here');
  m.replace('memory', 'TOKEN', '$& $1');
  expect(m.getEntries('memory')).toEqual(['price $& $1 here']);
});

test('remove 删唯一条目', () => {
  const m = new MemoryStore(dir);
  m.add('memory', 'keep');
  m.add('memory', 'delete-this');
  m.remove('memory', 'delete-this');
  expect(m.getEntries('memory')).toEqual(['keep']);
});

test('remove 未找到 → throw', () => {
  const m = new MemoryStore(dir);
  m.add('memory', 'a');
  expect(() => m.remove('memory', 'zzz')).toThrow();
});

test('损坏/缺失文件 → 空条目不崩', () => {
  expect(() => new MemoryStore(dir)).not.toThrow();
  expect(new MemoryStore(dir).getEntries('memory')).toEqual([]);
  writeFileSync(join(dir, 'MEMORY.md'), '');
  expect(new MemoryStore(dir).getEntries('memory')).toEqual([]);
});
