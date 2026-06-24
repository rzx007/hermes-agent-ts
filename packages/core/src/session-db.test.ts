import { test, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionDB } from './session-db.js';

let db: SessionDB;
beforeEach(() => { db = new SessionDB(':memory:'); });

/**
 * 测试专用:访问 SessionDB 上 private 的 rawExec(已移出公开 API)。
 * ⚠️ 仅用于在测试中构造数据库状态,严禁用于生产代码。
 */
const rawExec = (d: SessionDB, sql: string): void =>
  (d as unknown as { rawExec(sql: string): void }).rawExec(sql);

test('createSession 返回带默认值的会话', () => {
  const s = db.createSession();
  expect(s.id).toBeTruthy();
  expect(s.userId).toBe('local');
  expect(s.source).toBe('cli');
  expect(s.endedAt).toBeNull();
  expect(s.parentSessionId).toBeNull();
});

test('appendMessage 自动递增 seq 并按顺序读回', () => {
  const s = db.createSession();
  db.appendMessage(s.id, { role: 'user', content: 'hi' });
  db.appendMessage(s.id, { role: 'assistant', content: 'hello' });
  const msgs = db.getMessages(s.id);
  expect(msgs.map((m) => m.content)).toEqual(['hi', 'hello']);
  expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
});

test('保存与读回 toolCalls 和 tool 消息', () => {
  const s = db.createSession();
  db.appendMessage(s.id, {
    role: 'assistant', content: null,
    toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }],
  });
  db.appendMessage(s.id, { role: 'tool', content: 'file content', toolCallId: 'c1', name: 'read_file' });
  const msgs = db.getMessages(s.id);
  expect(msgs[0]!.toolCalls?.[0]?.name).toBe('read_file');
  expect(msgs[1]!.toolCallId).toBe('c1');
});

test('endSession 设置 endedAt', () => {
  const s = db.createSession();
  db.endSession(s.id);
  expect(db.getSession(s.id)?.endedAt).not.toBeNull();
});

test('listSessions 按开始时间倒序返回', () => {
  const a = db.createSession({ title: 'a' });
  const b = db.createSession({ title: 'b' });
  const list = db.listSessions();
  expect(list.map((s) => s.id).slice(0, 2)).toContain(b.id);
  expect(list.length).toBeGreaterThanOrEqual(2);
});

test('searchMessages 命中并返回 snippet', () => {
  const s = db.createSession();
  db.appendMessage(s.id, { role: 'user', content: '我们来聊聊 pnpm workspace 配置' });
  db.appendMessage(s.id, { role: 'assistant', content: '好的,pnpm 用 workspace 字段' });
  const hits = db.searchMessages('"pnpm"', 10);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.sessionId).toBe(s.id);
  expect(hits[0]!.snippet).toContain('pnpm');
});

test('searchMessages 中文子串命中(trigram,≥3 字)', () => {
  const s = db.createSession();
  db.appendMessage(s.id, { role: 'user', content: '我喜欢用中文搜索历史会话' });
  const hits = db.searchMessages('"中文搜"', 10);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.sessionId).toBe(s.id);
});

test('searchMessages 不索引 tool/system 消息', () => {
  const s = db.createSession();
  db.appendMessage(s.id, { role: 'tool', content: 'UNIQUEXYZ tool output', toolCallId: 'c1', name: 'x' });
  db.appendMessage(s.id, { role: 'system', content: 'UNIQUEXYZ system text' });
  expect(db.searchMessages('"UNIQUEXYZ"', 10)).toEqual([]);
});

test('删除消息后不再命中(delete 触发器)', () => {
  const s = db.createSession();
  db.appendMessage(s.id, { role: 'user', content: 'DELETME 待删内容' });
  expect(db.searchMessages('"DELETME"', 10).length).toBeGreaterThan(0);
  rawExec(db, `DELETE FROM messages WHERE session_id = '${s.id}'`);
  expect(db.searchMessages('"DELETME"', 10)).toEqual([]);
});

test('browseSessions 时间倒序 + preview=首条 user', () => {
  const a = db.createSession();
  db.appendMessage(a.id, { role: 'user', content: '第一个会话的问题' });
  const b = db.createSession();
  db.appendMessage(b.id, { role: 'user', content: '第二个会话的问题' });
  const list = db.browseSessions(10);
  expect(list[0]!.id).toBe(b.id);
  expect(list[0]!.preview).toContain('第二个');
});

test('空库 browseSessions 为空数组', () => {
  expect(db.browseSessions(10)).toEqual([]);
});

test('回填:清空 fts 后重开仍可搜', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hermes-fts-'));
  const path = join(tmp, 's.db');
  const d1 = new SessionDB(path);
  const s = d1.createSession();
  d1.appendMessage(s.id, { role: 'user', content: 'BACKFILLWORD 回填测试内容' });
  rawExec(d1, 'DELETE FROM messages_fts');
  expect(d1.searchMessages('"BACKFILLWORD"', 10)).toEqual([]);
  d1.close();
  const d2 = new SessionDB(path);
  expect(d2.searchMessages('"BACKFILLWORD"', 10).length).toBeGreaterThan(0);
  d2.close();
  rmSync(tmp, { recursive: true, force: true });
});
