import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';

// 用一个不存在 config.yaml 的临时 HERMES_HOME,确保测试不读到用户真实配置(hermetic)
const HOME = () => ({ HERMES_HOME: mkdtempSync(join(tmpdir(), 'hermes-cfg-')) });

test('loadConfig 解析 HERMES_ENABLED/DISABLED_TOOLSETS 逗号分隔', () => {
  const c = loadConfig({
    ...HOME(),
    GLM_API_KEY: 'k',
    HERMES_ENABLED_TOOLSETS: 'file, terminal',
    HERMES_DISABLED_TOOLSETS: 'terminal',
  } as NodeJS.ProcessEnv);
  expect(c.enabledToolsets).toEqual(['file', 'terminal']);
  expect(c.disabledToolsets).toEqual(['terminal']);
});

test('loadConfig 未设置时 toolsets 为 undefined', () => {
  const c = loadConfig({ ...HOME(), GLM_API_KEY: 'k' } as NodeJS.ProcessEnv);
  expect(c.enabledToolsets).toBeUndefined();
  expect(c.disabledToolsets).toBeUndefined();
});

test('HERMES_YOLO_MODE 真值 → approvalMode off', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k', HERMES_YOLO_MODE: '1' } as NodeJS.ProcessEnv).approvalMode).toBe('off');
});
test('HERMES_APPROVAL_MODE=off → off', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k', HERMES_APPROVAL_MODE: 'off' } as NodeJS.ProcessEnv).approvalMode).toBe('off');
});
test('默认 approvalMode = manual', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k' } as NodeJS.ProcessEnv).approvalMode).toBe('manual');
});

test('skillNudgeInterval 默认 10', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k' } as NodeJS.ProcessEnv).skillNudgeInterval).toBe(10);
});
test('skillNudgeInterval 读 env', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k', HERMES_SKILL_NUDGE_INTERVAL: '5' } as NodeJS.ProcessEnv).skillNudgeInterval).toBe(5);
});
test('skillNudgeInterval=0 表示关闭(不被默认覆盖)', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k', HERMES_SKILL_NUDGE_INTERVAL: '0' } as NodeJS.ProcessEnv).skillNudgeInterval).toBe(0);
});
test('skillNudgeInterval 非法值回退 10', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k', HERMES_SKILL_NUDGE_INTERVAL: 'abc' } as NodeJS.ProcessEnv).skillNudgeInterval).toBe(10);
});
