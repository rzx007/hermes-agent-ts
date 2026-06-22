import { test, expect } from 'vitest';
import { terminalTool } from './terminal.js';
import { createLogger } from '@hermes/core';

const ctx = { cwd: process.cwd(), logger: createLogger('test') };

test('terminal 执行命令并返回 stdout 与 exitCode', async () => {
  const out = await terminalTool.handler({ command: 'echo hermes' }, ctx);
  expect(out).toContain('hermes');
  expect(out).toContain('exit code: 0');
});

test('terminal 非零退出码也返回（不抛）', async () => {
  const out = await terminalTool.handler({ command: 'exit 3' }, ctx);
  expect(out).toContain('exit code: 3');
});

test('terminal 超时被终止', async () => {
  const out = await terminalTool.handler({ command: 'sleep 5', timeout: 500 }, ctx);
  expect(out.toLowerCase()).toContain('timeout');
}, 10000);

test('terminal 在 AbortSignal 触发时终止并返回', async () => {
  const ac = new AbortController();
  const p = terminalTool.handler({ command: 'sleep 10' }, { ...ctx, signal: ac.signal });
  ac.abort();
  const out = await p;
  expect(out).toContain('exit code:');
}, 5000);

import { ApprovalGuard } from '../approval.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function denyGuard() {
  return new ApprovalGuard({ mode: 'manual', allowlistPath: join(mkdtempSync(join(tmpdir(), 'al-')), 'a.json'), prompt: async () => 'deny' });
}
function allowGuard() {
  return new ApprovalGuard({ mode: 'manual', allowlistPath: join(mkdtempSync(join(tmpdir(), 'al-')), 'a.json'), prompt: async () => 'once' });
}

test('注入 deny guard:危险命令被阻止且不执行', async () => {
  const out = await terminalTool.handler({ command: 'rm -rf ./should-not-run' }, { cwd: process.cwd(), logger: createLogger('t'), approval: denyGuard() });
  expect(out).toContain('拒绝');
});

test('注入 allow guard:危险命令放行执行', async () => {
  const out = await terminalTool.handler({ command: 'echo danger; rm -rf ./nonexistent-xyz' }, { cwd: process.cwd(), logger: createLogger('t'), approval: allowGuard() });
  expect(out).toContain('exit code');
});

test('注入 guard:safe 命令照常执行', async () => {
  const out = await terminalTool.handler({ command: 'echo safe' }, { cwd: process.cwd(), logger: createLogger('t'), approval: denyGuard() });
  expect(out).toContain('safe');
  expect(out).toContain('exit code: 0');
});
