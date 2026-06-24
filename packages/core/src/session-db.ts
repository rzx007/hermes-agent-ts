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
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq ON messages(session_id, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, tokenize='trigram');

CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages
WHEN new.role IN ('user','assistant') BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, COALESCE(new.content,''));
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.id;
  INSERT INTO messages_fts(rowid, content)
    SELECT new.id, COALESCE(new.content,'') WHERE new.role IN ('user','assistant');
END;
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

export interface SearchHit {
  sessionId: string;
  messageId: number;
  role: string;
  createdAt: number;
  snippet: string;
}

export interface SessionBrief {
  id: string;
  startedAt: number;
  preview: string;
}

export class SessionDB {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.backfillFts();
  }

  private backfillFts(): void {
    this.db.exec(
      `INSERT INTO messages_fts(rowid, content)
       SELECT id, COALESCE(content,'') FROM messages
       WHERE role IN ('user','assistant')
         AND id NOT IN (SELECT rowid FROM messages_fts)`,
    );
  }

  createSession(opts: CreateSessionOpts = {}): Session {
    const s: Session = {
      id: uuid(),
      userId: opts.userId ?? 'local',
      title: opts.title ?? null,
      source: opts.source ?? 'cli',
      startedAt: Date.now(),
      endedAt: null,
      parentSessionId: null, // TODO(phase2): expose parentSessionId via CreateSessionOpts (压缩链/分支)
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
    this.db.transaction(() => {
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
    })();
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

  /**
   * 全文搜索消息(trigram FTS5)。
   * @param query 必须是合法的 FTS5 查询串——原始用户输入请先用 @hermes/tools 的
   *   sanitizeFtsQuery() 转成字面短语,否则可能触发 FTS5 语法错误。
   * @param limit 返回上限(默认 30)。
   */
  searchMessages(query: string, limit = 30): SearchHit[] {
    return this.db.prepare(
      `SELECT m.session_id AS sessionId, m.id AS messageId, m.role AS role,
              m.created_at AS createdAt,
              snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    ).all(query, limit) as SearchHit[];
  }

  browseSessions(limit = 10): SessionBrief[] {
    return this.db.prepare(
      `SELECT s.id AS id, s.started_at AS startedAt,
              COALESCE((SELECT content FROM messages
                        WHERE session_id = s.id AND role = 'user'
                        ORDER BY seq LIMIT 1), '') AS preview
       FROM sessions s
       ORDER BY s.started_at DESC, s.rowid DESC
       LIMIT ?`,

    ).all(limit) as SessionBrief[];
  }

  /**
   * 执行任意 SQL —— 仅供测试/内部维护使用。
   * ⚠️ 不做参数化,严禁传入不可信输入(SQL 注入风险)。生产代码请用专用方法。
   */
  rawExec(sql: string): void {
    this.db.exec(sql);
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
