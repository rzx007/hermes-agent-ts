import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionDB, createLogger } from '@hermes/core';
import { sessionSearchTool } from './session-search.js';

let dir: string;
let db: SessionDB;
const ctx = () => ({ cwd: process.cwd(), logger: createLogger('test'), sessionDb: db });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hermes-ss-')); db = new SessionDB(join(dir, 's.db')); });
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

test('discovery 命中并格式化', async () => {
  const s = db.createSession();
  db.appendMessage(s.id, { role: 'user', content: '聊聊 pnpm workspace' });
  const out = await sessionSearchTool.handler({ query: 'pnpm' }, ctx());
  expect(out).toContain(s.id.slice(0, 8));
  expect(out.toLowerCase()).toContain('pnpm');
});

test('browse 无 query 列最近会话', async () => {
  const s = db.createSession();
  db.appendMessage(s.id, { role: 'user', content: '第一个问题啊' });
  const out = await sessionSearchTool.handler({}, ctx());
  expect(out).toContain(s.id.slice(0, 8));
  expect(out).toContain('第一个');
});

test('query < 3 字符提示', async () => {
  const out = await sessionSearchTool.handler({ query: 'ab' }, ctx());
  expect(out).toContain('3');
});

test('无匹配提示', async () => {
  db.createSession();
  const out = await sessionSearchTool.handler({ query: 'ZZZNOMATCHQQ' }, ctx());
  expect(out).toContain('无匹配');
});

test('无 ctx.sessionDb 返回不可用', async () => {
  const out = await sessionSearchTool.handler(
    { query: 'pnpm' },
    { cwd: process.cwd(), logger: createLogger('test') },
  );
  expect(out).toContain('不可用');
});

test('多会话按 sessionId 去重', async () => {
  const a = db.createSession();
  db.appendMessage(a.id, { role: 'user', content: 'TOPIC alpha 内容一' });
  db.appendMessage(a.id, { role: 'assistant', content: 'TOPIC 又一条 alpha' });
  const out = await sessionSearchTool.handler({ query: 'TOPIC' }, ctx());
  const code = a.id.slice(0, 8);
  const occurrences = out.split(code).length - 1;
  expect(occurrences).toBe(1);
});

test('limit 负数/0/超大 被 schema 拒绝(经 registry 校验)', () => {
  // 直接验证 schema 拒绝非法 limit(工具经 registry.call 时会被 Zod 校验)
  const schema = sessionSearchTool.schema;
  expect(schema.safeParse({ query: 'pnpm', limit: -1 }).success).toBe(false);
  expect(schema.safeParse({ query: 'pnpm', limit: 0 }).success).toBe(false);
  expect(schema.safeParse({ query: 'pnpm', limit: 1.5 }).success).toBe(false);
  expect(schema.safeParse({ query: 'pnpm', limit: 100 }).success).toBe(false);
  expect(schema.safeParse({ query: 'pnpm', limit: 10 }).success).toBe(true);
  expect(schema.safeParse({ query: 'pnpm' }).success).toBe(true); // limit 可省略
});
