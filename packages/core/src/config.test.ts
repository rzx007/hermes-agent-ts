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
