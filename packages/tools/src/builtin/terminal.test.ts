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
