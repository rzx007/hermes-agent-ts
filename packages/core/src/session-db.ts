import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { Session, Message, CreateSessionOpts } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  source TEXT NOT NULL DEFAULT 'cli',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  parent_session_id TEXT,
  model_config TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  name TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
`;

interface SessionRow {
  id: string; user_id: string; title: string | null; source: string;
  started_at: number; ended_at: number | null;
  parent_session_id: string | null; model_config: string;
}
interface MessageRow {
  role: string; content: string | null; tool_calls: string | null;
  tool_call_id: string | null; name: string | null;
}

export class SessionDB {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  createSession(opts: CreateSessionOpts = {}): Session {
    const s: Session = {
      id: uuid(),
      userId: opts.userId ?? 'local',
      title: opts.title ?? null,
      source: opts.source ?? 'cli',
      startedAt: Date.now(),
      endedAt: null,
      parentSessionId: null,
      modelConfig: opts.modelConfig ?? {},
    };
    this.db.prepare(
      `INSERT INTO sessions (id,user_id,title,source,started_at,ended_at,parent_session_id,model_config)
       VALUES (@id,@userId,@title,@source,@startedAt,@endedAt,@parentSessionId,@modelConfig)`,
    ).run({ ...s, modelConfig: JSON.stringify(s.modelConfig) });
    return s;
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row ? this.rowToSession(row) : null;
  }

  endSession(id: string): void {
    this.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(Date.now(), id);
  }

  appendMessage(sessionId: string, msg: Message): void {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM messages WHERE session_id = ?')
      .get(sessionId) as { next: number };
    this.db.prepare(
      `INSERT INTO messages (session_id,seq,role,content,tool_calls,tool_call_id,name,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      sessionId, row.next, msg.role, msg.content,
      msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
      msg.toolCallId ?? null, msg.name ?? null, Date.now(),
    );
  }

  getMessages(sessionId: string): Message[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as MessageRow[];
    return rows.map((r) => ({
      role: r.role as Message['role'],
      content: r.content,
      toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
      toolCallId: r.tool_call_id ?? undefined,
      name: r.name ?? undefined,
    }));
  }

  listSessions(limit = 50): Session[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?')
      .all(limit) as SessionRow[];
    return rows.map((r) => this.rowToSession(r));
  }

  close(): void { this.db.close(); }

  private rowToSession(r: SessionRow): Session {
    return {
      id: r.id, userId: r.user_id, title: r.title, source: r.source,
      startedAt: r.started_at, endedAt: r.ended_at,
      parentSessionId: r.parent_session_id,
      modelConfig: JSON.parse(r.model_config),
    };
  }
}
