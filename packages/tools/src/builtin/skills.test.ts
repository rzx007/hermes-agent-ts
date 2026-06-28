import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillStore, createLogger } from '@hermes/core';
import { skillViewTool, skillManageTool } from './skills.js';
import { ApprovalGuard } from '../approval.js';

let dir: string;
let skills: SkillStore;
const ctx = () => ({ cwd: process.cwd(), logger: createLogger('test'), skills });
const ctxA = (approval?: ApprovalGuard) => ({ cwd: process.cwd(), logger: createLogger('test'), skills, approval });
const FM = (name: string) => `---\nname: ${name}\ndescription: d\n---\n\n正文`;
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

test('skill_manage create 新建并热更新可见', async () => {
  const out = await skillManageTool.handler({ action: 'create', name: 'a', content: FM('a') }, ctxA());
  expect(out).toContain('已创建');
  expect(skills.getContent('a')).toContain('正文');
});

test('skill_manage create 缺 content 报错', async () => {
  await expect(skillManageTool.handler({ action: 'create', name: 'a' }, ctxA())).rejects.toThrow(/content/);
});

test('skill_manage edit 更新技能', async () => {
  const out = await skillManageTool.handler(
    { action: 'edit', name: 'demo', content: '---\nname: demo\ndescription: 新\n---\n\n新正文' },
    ctxA(),
  );
  expect(out).toContain('已更新');
  expect(skills.getContent('demo')).toContain('新正文');
});

test('skill_manage patch 缺 new_string 报错', async () => {
  await expect(skillManageTool.handler({ action: 'patch', name: 'demo', old_string: '操作步骤' }, ctxA()))
    .rejects.toThrow(/new_string|old_string/);
});

test('skill_manage delete 经 approval 确认(允许)', async () => {
  const guard = new ApprovalGuard({ mode: 'off', allowlistPath: join(dir, 'al.json') });
  const out = await skillManageTool.handler({ action: 'delete', name: 'demo' }, ctxA(guard));
  expect(out).toContain('已删除');
  expect(skills.getContent('demo')).toBeNull();
});

test('skill_manage delete 被 approval 拒绝则不删', async () => {
  const guard = new ApprovalGuard({ mode: 'manual', allowlistPath: join(dir, 'al.json'), prompt: async () => 'deny' });
  const out = await skillManageTool.handler({ action: 'delete', name: 'demo' }, ctxA(guard));
  expect(out).toContain('拒绝');
  expect(skills.getContent('demo')).not.toBeNull();
});

test('skill_manage 无 ctx.skills 返回不可用', async () => {
  const out = await skillManageTool.handler(
    { action: 'create', name: 'a', content: FM('a') },
    { cwd: process.cwd(), logger: createLogger('test') },
  );
  expect(out).toBe('技能系统不可用。');
});

test('skill_manage 已注册(builtinTools 含 skill_manage)', async () => {
  const { builtinTools } = await import('./index.js');
  expect(builtinTools.map((t) => t.name)).toContain('skill_manage');
});

test('skill_manage create 默认 agentCreated=false(前台)', async () => {
  await skillManageTool.handler({ action: 'create', name: 'fg', content: FM('fg') }, ctxA());
  expect(skills.usageEntries().find(([n]) => n === 'fg')?.[1].agentCreated).toBe(false);
});

test('skill_manage create 在 backgroundReview 下标 agentCreated=true', async () => {
  const ctx = { cwd: process.cwd(), logger: createLogger('test'), skills, backgroundReview: true };
  await skillManageTool.handler({ action: 'create', name: 'bg', content: FM('bg') }, ctx);
  expect(skills.usageEntries().find(([n]) => n === 'bg')?.[1].agentCreated).toBe(true);
});

test('skill_view 记一次 view', async () => {
  skills.create('demo2', FM('demo2'));
  await skillViewTool.handler({ name: 'demo2' }, ctxA());
  expect(skills.usageEntries().find(([n]) => n === 'demo2')?.[1].viewCount).toBe(1);
});
