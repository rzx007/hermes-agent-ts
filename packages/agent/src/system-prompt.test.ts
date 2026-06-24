import { test, expect } from 'vitest';
import { buildSystemPrompt } from './system-prompt.js';

test('buildSystemPrompt 含 cwd', () => {
  expect(buildSystemPrompt('/work')).toContain('/work');
});

test('buildSystemPrompt 带 memoryBlock 时包含它', () => {
  const out = buildSystemPrompt('/work', '════ MEMORY ════\n喜欢 pnpm');
  expect(out).toContain('喜欢 pnpm');
});

test('buildSystemPrompt 不带 memoryBlock 时不含记忆标记', () => {
  expect(buildSystemPrompt('/work')).not.toContain('MEMORY');
});

test('buildSystemPrompt 带 skillsBlock 时包含它', () => {
  const out = buildSystemPrompt('/work', undefined, '可用技能:\n- **demo** — 演示');
  expect(out).toContain('demo');
});

test('buildSystemPrompt 不带 skillsBlock 不含技能标记', () => {
  expect(buildSystemPrompt('/work')).not.toContain('可用技能');
});

test('memory 与 skills 块可共存', () => {
  const out = buildSystemPrompt('/work', '记忆X', '可用技能:\n- **demo** — d');
  expect(out).toContain('记忆X');
  expect(out).toContain('demo');
});
