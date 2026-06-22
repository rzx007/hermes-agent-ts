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
