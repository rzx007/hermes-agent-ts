import { test, expect } from 'vitest';
import { getHermesHome, sessionDbPath, ensureHermesHome, allowlistPath, memoriesDir, skillsDir } from './paths.js';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('getHermesHome 尊重 HERMES_HOME 环境变量', () => {
  const dir = getHermesHome({ HERMES_HOME: '/tmp/custom-hermes' });
  expect(dir).toBe('/tmp/custom-hermes');
});

test('getHermesHome 默认回退到 ~/.hermes-ts', () => {
  const dir = getHermesHome({ HOME: '/home/u' });
  expect(dir.replace(/\\/g, '/')).toBe('/home/u/.hermes-ts');
});

test('sessionDbPath 在 hermes home 下指向 sessions.db', () => {
  expect(sessionDbPath({ HOME: '/home/u' }).replace(/\\/g, '/')).toBe('/home/u/.hermes-ts/sessions.db');
});

test('ensureHermesHome 创建目录并返回路径', () => {
  const base = mkdtempSync(join(tmpdir(), 'hermes-paths-'));
  const dir = ensureHermesHome({ HERMES_HOME: join(base, 'h') });
  expect(existsSync(dir)).toBe(true);
  rmSync(base, { recursive: true, force: true });
});

test('allowlistPath 在 hermes home 下指向 allowlist.json', () => {
  expect(allowlistPath({ HOME: '/home/u' }).replace(/\\/g, '/')).toBe('/home/u/.hermes-ts/allowlist.json');
});

test('memoriesDir 在 hermes home 下指向 memories', () => {
  expect(memoriesDir({ HOME: '/home/u' }).replace(/\\/g, '/')).toBe('/home/u/.hermes-ts/memories');
});

test('skillsDir 在 hermes home 下指向 skills', () => {
  expect(skillsDir({ HOME: '/home/u' }).replace(/\\/g, '/')).toBe('/home/u/.hermes-ts/skills');
});
