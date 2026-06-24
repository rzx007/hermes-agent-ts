import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillStore, createLogger } from '@hermes/core';
import { skillViewTool } from './skills.js';

let dir: string;
let skills: SkillStore;
const ctx = () => ({ cwd: process.cwd(), logger: createLogger('test'), skills });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-skv-'));
  const d = join(dir, 'demo');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), '---\nname: demo\ndescription: 演示\n---\n# Demo\n操作步骤', 'utf8');
  skills = new SkillStore(dir);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('skill_view 返回正文', async () => {
  const out = await skillViewTool.handler({ name: 'demo' }, ctx());
  expect(out).toContain('# Demo');
  expect(out).toContain('操作步骤');
});

test('skill_view 未知名报错(含可用名)', async () => {
  await expect(skillViewTool.handler({ name: 'nope' }, ctx())).rejects.toThrow(/demo/);
});

test('无 ctx.skills 返回不可用', async () => {
  const out = await skillViewTool.handler(
    { name: 'demo' },
    { cwd: process.cwd(), logger: createLogger('test') },
  );
  expect(out).toContain('不可用');
});
