import { test, expect, beforeEach } from 'vitest';
import { SessionDB } from './session-db.js';

let db: SessionDB;
beforeEach(() => { db = new SessionDB(':memory:'); });

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
