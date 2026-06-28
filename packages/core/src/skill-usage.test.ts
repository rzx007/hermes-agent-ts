import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillUsage } from './skill-usage.js';

let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hermes-usage-')); path = join(dir, '.usage.json'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const T0 = new Date('2026-01-01T00:00:00Z');

test('create 新建条目(整条,active,counts 0)', () => {
  const u = new SkillUsage(path);
  u.create('a', { agentCreated: true, now: T0 });
  const e = u.get('a')!;
  expect(e.agentCreated).toBe(true);
  expect(e.state).toBe('active');
  expect(e.viewCount).toBe(0);
  expect(e.createdAt).toBe(T0.toISOString());
  expect(e.lastUsedAt).toBe(T0.toISOString());
});

test('create 覆盖旧条目(同名重建重置 provenance)', () => {
  const u = new SkillUsage(path);
  u.create('a', { agentCreated: true, now: T0 });
  u.record('a', { state: 'archived' });
  u.create('a', { agentCreated: false, now: T0 }); // 前台重建
  const e = u.get('a')!;
  expect(e.agentCreated).toBe(false);
  expect(e.state).toBe('active');
});

test('record view/patch 累加并更新 lastUsedAt;不动 agentCreated', () => {
  const u = new SkillUsage(path);
  u.create('a', { agentCreated: true, now: T0 });
  const T1 = new Date('2026-02-01T00:00:00Z');
  u.record('a', { view: true, now: T1 });
  u.record('a', { patch: true, now: T1 });
  const e = u.get('a')!;
  expect(e.viewCount).toBe(1);
  expect(e.patchCount).toBe(1);
  expect(e.lastUsedAt).toBe(T1.toISOString());
  expect(e.agentCreated).toBe(true);
});

test('record 缺条目 → 以 agentCreated=false 新建', () => {
  const u = new SkillUsage(path);
  u.record('legacy', { view: true, now: T0 });
  const e = u.get('legacy')!;
  expect(e.agentCreated).toBe(false);
  expect(e.viewCount).toBe(1);
});

test('remove 删除条目', () => {
  const u = new SkillUsage(path);
  u.create('a', { agentCreated: true, now: T0 });
  u.remove('a');
  expect(u.get('a')).toBeUndefined();
});

test('原子写后可重新加载', () => {
  const u = new SkillUsage(path);
  u.create('a', { agentCreated: true, now: T0 });
  const u2 = new SkillUsage(path);
  expect(u2.get('a')?.agentCreated).toBe(true);
});

test('坏 json 容错 → 空', () => {
  writeFileSync(path, '{ not json', 'utf8');
  const u = new SkillUsage(path);
  expect(u.entries()).toEqual([]);
});

test('缺文件 → 空,不崩', () => {
  const u = new SkillUsage(join(dir, 'nope', '.usage.json'));
  expect(u.entries()).toEqual([]);
});
