import { test, expect } from 'vitest';
import { resolveToolset, computeEnabledTools, TOOLSETS } from './toolsets.js';

test('TOOLSETS 含 file/terminal/core', () => {
  expect(Object.keys(TOOLSETS)).toEqual(expect.arrayContaining(['file', 'terminal', 'core']));
});

test('resolveToolset 展开叶子分组', () => {
  expect(resolveToolset('terminal')).toEqual(['terminal']);
  expect(resolveToolset('file').sort()).toEqual(['edit_file', 'list_dir', 'read_file', 'search_files', 'write_file']);
});

test('resolveToolset 递归展开 includes(core→file+terminal)', () => {
  const tools = resolveToolset('core').sort();
  expect(tools).toContain('read_file');
  expect(tools).toContain('terminal');
  expect(tools).toContain('edit_file');
});

test("resolveToolset 'all'/'*' 返回所有 toolset 工具并集", () => {
  const all = resolveToolset('all').sort();
  expect(all).toContain('read_file');
  expect(all).toContain('terminal');
  expect(resolveToolset('*').sort()).toEqual(all);
});

test('resolveToolset 未知名返回空数组', () => {
  expect(resolveToolset('nope')).toEqual([]);
});

test('resolveToolset 环依赖不死循环', () => {
  expect(() => resolveToolset('core')).not.toThrow();
});

test('computeEnabledTools 默认(enabled undefined)= 全部已注册', () => {
  const registered = ['read_file', 'terminal', 'unknown_extra'];
  expect(computeEnabledTools({}, registered).sort()).toEqual(['read_file', 'terminal', 'unknown_extra'].sort());
});

test('computeEnabledTools enabled 子集 + 与已注册取交集', () => {
  const registered = ['read_file', 'write_file', 'terminal'];
  const out = computeEnabledTools({ enabled: ['file'] }, registered).sort();
  expect(out).toEqual(['read_file', 'write_file']);
});

test('computeEnabledTools disabled 相减', () => {
  const registered = ['read_file', 'write_file', 'terminal'];
  const out = computeEnabledTools({ enabled: ['core'], disabled: ['terminal'] }, registered).sort();
  expect(out).toEqual(['read_file', 'write_file']);
});

test('computeEnabledTools 未知 toolset 跳过(不抛)', () => {
  const registered = ['read_file', 'terminal'];
  expect(() => computeEnabledTools({ enabled: ['nope'] }, registered)).not.toThrow();
  expect(computeEnabledTools({ enabled: ['nope'] }, registered)).toEqual([]);
});
