import { test, expect } from 'vitest';
import { getHermesHome } from './paths.js';

test('getHermesHome 尊重 HERMES_HOME 环境变量', () => {
  const dir = getHermesHome({ HERMES_HOME: '/tmp/custom-hermes' });
  expect(dir).toBe('/tmp/custom-hermes');
});

test('getHermesHome 默认回退到 ~/.hermes', () => {
  const dir = getHermesHome({ HOME: '/home/u' });
  expect(dir.replace(/\\/g, '/')).toBe('/home/u/.hermes');
});
