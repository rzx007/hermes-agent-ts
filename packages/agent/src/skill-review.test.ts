import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@hermes/core';
import { SkillStore, createLogger } from '@hermes/core';
import type { Provider, CompletionResult } from '@hermes/providers';
import { ToolRegistry, registerBuiltins, ApprovalGuard, type ToolContext } from '@hermes/tools';
import { runSkillReview, shouldTriggerReview } from './skill-review.js';

// 脚本化 fake provider：complete 记录收到的 messages、不产 chunk；aggregate 依次吐 results
function scripted(results: CompletionResult[]): { provider: Provider; seen: Message[][] } {
  const seen: Message[][] = [];
  let i = 0;
  const provider: Provider = {
    name: 'fake',
    async *complete(req) { seen.push(req.messages.map((m) => ({ ...m }))); /* 无 chunk */ },
    async aggregate() { const r = results[Math.min(i, results.length - 1)]!; i++; return r; },
  };
  return { provider, seen };
}
const tc = (id: string, name: string, args: object) => ({ id, name, arguments: JSON.stringify(args) });
const SKILL = (name: string) => `---\nname: ${name}\ndescription: d\n---\n\n正文`;

let dir: string;
let skills: SkillStore;
let registry: ToolRegistry;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-review-'));
  skills = new SkillStore(dir);
  registry = new ToolRegistry();
  registerBuiltins(registry);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function reviewCtx(approval?: ApprovalGuard): ToolContext {
  return { cwd: process.cwd(), logger: createLogger('test'), skills, approval };
}
const snapshot: Message[] = [
  { role: 'user', content: '帮我改三个文件' },
  { role: 'assistant', content: '改完了' },
];

test('runSkillReview: 模型 create 技能 → 技能被建 + actions 收录', async () => {
  const { provider } = scripted([
    { content: null, toolCalls: [tc('1', 'skill_manage', { action: 'create', name: 'batch-edit', content: SKILL('batch-edit') })], finishReason: 'tool_calls' },
    { content: '已更新技能库。', toolCalls: [], finishReason: 'stop' },
  ]);
  const sum = await runSkillReview({ provider, registry, model: 'm' }, snapshot, reviewCtx());
  expect(skills.getContent('batch-edit')).toContain('正文');
  expect(sum.actions.some((a) => a.startsWith('已创建'))).toBe(true);
  expect(sum.iterations).toBe(1);
});

test('runSkillReview: delete 被无 prompt guard 挡下 → 技能仍在、不计入 actions', async () => {
  skills.create('keep', SKILL('keep'));
  const guard = new ApprovalGuard({ mode: 'manual', allowlistPath: join(dir, 'noallow.json') }); // 无 prompt
  const { provider } = scripted([
    { content: null, toolCalls: [tc('1', 'skill_manage', { action: 'delete', name: 'keep' })], finishReason: 'tool_calls' },
    { content: '完成。', toolCalls: [], finishReason: 'stop' },
  ]);
  const sum = await runSkillReview({ provider, registry, model: 'm' }, snapshot, reviewCtx(guard));
  expect(skills.getContent('keep')).not.toBeNull();
  expect(sum.actions.some((a) => a.startsWith('已删除'))).toBe(false);
});

test('runSkillReview: 消息回环带 toolCallId/name 与 assistant.toolCalls', async () => {
  const { provider, seen } = scripted([
    { content: null, toolCalls: [tc('cx', 'skill_view', { name: 'nope' })], finishReason: 'tool_calls' },
    { content: '完成。', toolCalls: [], finishReason: 'stop' },
  ]);
  await runSkillReview({ provider, registry, model: 'm' }, snapshot, reviewCtx());
  const second = seen[1]!;
  expect(second.some((m) => m.role === 'tool' && m.toolCallId === 'cx' && m.name === 'skill_view')).toBe(true);
  expect(second.some((m) => m.role === 'assistant' && Array.isArray(m.toolCalls))).toBe(true);
});

test('runSkillReview: 达 maxIterations 即停', async () => {
  const loopRes: CompletionResult = { content: null, toolCalls: [tc('1', 'skill_view', { name: 'x' })], finishReason: 'tool_calls' };
  const { provider } = scripted([loopRes, loopRes, loopRes, loopRes]);
  const sum = await runSkillReview({ provider, registry, model: 'm', maxIterations: 2 }, snapshot, reviewCtx());
  expect(sum.iterations).toBe(2);
});

test('runSkillReview: provider 抛错 → 返回 error、不崩、actions 空', async () => {
  const provider: Provider = {
    name: 'boom',
    async *complete() { throw new Error('网络炸了'); },
    async aggregate() { return { content: '', toolCalls: [], finishReason: 'stop' }; },
  };
  const sum = await runSkillReview({ provider, registry, model: 'm' }, snapshot, reviewCtx());
  expect(sum.error).toBeTruthy();
  expect(sum.actions).toEqual([]);
});

test('runSkillReview 写入标记为 agent 建(backgroundReview 注入)', async () => {
  const { provider } = scripted([
    { content: null, toolCalls: [tc('1', 'skill_manage', { action: 'create', name: 'learned', content: SKILL('learned') })], finishReason: 'tool_calls' },
    { content: '完成。', toolCalls: [], finishReason: 'stop' },
  ]);
  await runSkillReview({ provider, registry, model: 'm' }, snapshot, reviewCtx());
  expect(skills.usageEntries().find(([n]) => n === 'learned')?.[1].agentCreated).toBe(true);
});

test('shouldTriggerReview: 阈值/关闭/缺 skill_manage', () => {
  expect(shouldTriggerReview(10, 10, ['skill_manage'])).toBe(true);
  expect(shouldTriggerReview(9, 10, ['skill_manage'])).toBe(false);
  expect(shouldTriggerReview(99, 0, ['skill_manage'])).toBe(false);
  expect(shouldTriggerReview(10, 10, ['skill_view'])).toBe(false);
});
