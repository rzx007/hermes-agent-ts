import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillStore } from './skill-store.js';
import { SkillUsage } from './skill-usage.js';
import { runCurator } from './skill-curator.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hermes-cur-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const SKILL = (n: string) => `---\nname: ${n}\ndescription: d\n---\n\n正文`;
const NOW = new Date('2026-06-01T00:00:00Z');
const LONG_AGO = new Date('2026-01-01T00:00:00Z'); // 距 NOW ~151 天

// 建真实技能文件 + 把其 usage 条目时间戳覆盖为 lastUsed,返回重载后的 store
function seedAgentSkill(name: string, lastUsed: Date, agentCreated = true): SkillStore {
  const s = new SkillStore(dir);
  s.create(name, SKILL(name), undefined, { agentCreated });
  const u = new SkillUsage(join(dir, '.usage.json'));
  u.create(name, { agentCreated, now: lastUsed }); // create 整条覆盖,createdAt=lastUsedAt=lastUsed
  return new SkillStore(dir); // 重新加载,带老时间戳
}

test('归档 agent 建且超阈值', () => {
  const store = seedAgentSkill('old', LONG_AGO);
  const rep = runCurator(store, { archiveAfterDays: 30, now: NOW });
  expect(rep.archived).toContain('old');
  expect(existsSync(join(dir, '.archive', 'old', 'SKILL.md'))).toBe(true);
});

test('用户建(agentCreated=false)永不归档', () => {
  const store = seedAgentSkill('user', LONG_AGO, false);
  const rep = runCurator(store, { archiveAfterDays: 30, now: NOW });
  expect(rep.archived).toEqual([]);
});

test('active 未超阈值不归档', () => {
  const store = seedAgentSkill('fresh', new Date('2026-05-20T00:00:00Z')); // 距 NOW ~12 天
  const rep = runCurator(store, { archiveAfterDays: 30, now: NOW });
  expect(rep.archived).toEqual([]);
});

test('archiveAfterDays=0 关闭', () => {
  const store = seedAgentSkill('old', LONG_AGO);
  const rep = runCurator(store, { archiveAfterDays: 0, now: NOW });
  expect(rep.archived).toEqual([]);
  expect(rep.scanned).toBe(0);
});

test('坏时间戳条目 → NaN → 不归档', () => {
  const s = new SkillStore(dir);
  s.create('weird', SKILL('weird'), undefined, { agentCreated: true });
  const u = new SkillUsage(join(dir, '.usage.json'));
  const e = u.get('weird')!;
  e.lastUsedAt = 'bad';
  e.createdAt = 'bad';
  u.record('weird', {}); // 全 undefined opts 仍会 save,持久化坏值
  const store = new SkillStore(dir);
  const rep = runCurator(store, { archiveAfterDays: 30, now: NOW });
  expect(rep.archived).toEqual([]);
});
