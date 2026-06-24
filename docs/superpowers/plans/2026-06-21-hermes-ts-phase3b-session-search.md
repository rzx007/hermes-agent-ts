# Hermes TS 阶段 3b:会话全文搜索(session_search) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 能全文搜索过往会话历史——SessionDB 加 trigram FTS5 + `session_search` 工具(discovery + browse)。

**Architecture:** SessionDB 加单张 `messages_fts`(trigram)虚拟表 + 触发器(只索引 user/assistant)+ 幂等回填,新增 `searchMessages`/`browseSessions`。`session_search` 工具(@hermes/tools)经 `ToolContext.sessionDb` 查;`sanitizeFtsQuery` 把查询当字面短语防注入;新 `search` toolset 并入 core;CLI 每轮注入 `sessionDb: deps.db`(沿用 memory/approval 模式)。

**Tech Stack:** 沿用阶段 1-3a(Node 20+ / TS strict / pnpm / Vitest / Zod / better-sqlite3 FTS5)。无新增依赖。

**Spec:** `docs/superpowers/specs/2026-06-21-hermes-ts-phase3b-session-search-design.md`

**前置状态:** 阶段 1/2/2.5/3a 完成并合并。当前在 `phase3b-session-search` 分支,基线已实测 **125 测试全绿**。内部包指向源码解析。工具用 `defineTool`,`registry.call` 捕获工具异常转错误字符串回灌。HERMES_HOME = `~/.hermes-ts`。

---

## 文件结构总览

| 文件 | 职责 |
|------|------|
| `packages/core/src/session-db.ts`(改) | FTS5 schema + 触发器 + 回填 + searchMessages + browseSessions + 类型导出 |
| `packages/core/src/session-db.test.ts`(改) | FTS 测试 |
| `packages/tools/src/fts-query.ts`(新) | sanitizeFtsQuery |
| `packages/tools/src/fts-query.test.ts`(新) | |
| `packages/tools/src/registry.ts`(改) | ToolContext.sessionDb?: SessionDB |
| `packages/tools/src/toolsets.ts`(改) | search toolset + core.includes 加 search |
| `packages/tools/src/toolsets.test.ts`(改) | |
| `packages/tools/src/builtin/session-search.ts`(新) | session_search 工具 |
| `packages/tools/src/builtin/session-search.test.ts`(新) | |
| `packages/tools/src/builtin/index.ts`(改) | 注册 session_search |
| `packages/tools/src/index.ts`(改) | 导出 fts-query |
| `apps/cli/src/repl.ts`(改) | 每轮注入 sessionDb: deps.db |

---

## Task 1:SessionDB FTS5(表 + 触发器 + 回填 + 搜索方法)

**Files:**
- Modify: `packages/core/src/session-db.ts`, `packages/core/src/session-db.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/session-db.test.ts` 追加(顶部已有 `import { SessionDB } from './session-db.js'`;新增 `SearchHit`/`SessionBrief` 不需显式 import,用结构断言即可。需要 better-sqlite3 直接操作时另起说明):
```ts
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
  db.rawExec(`DELETE FROM messages WHERE session_id = '${s.id}'`);
  expect(db.searchMessages('"DELETME"', 10)).toEqual([]);
});

test('browseSessions 时间倒序 + preview=首条 user', () => {
  const a = db.createSession();
  db.appendMessage(a.id, { role: 'user', content: '第一个会话的问题' });
  const b = db.createSession();
  db.appendMessage(b.id, { role: 'user', content: '第二个会话的问题' });
  const list = db.browseSessions(10);
  expect(list[0]!.id).toBe(b.id); // 最新在前
  expect(list[0]!.preview).toContain('第二个');
});

test('空库 browseSessions 为空数组', () => {
  expect(db.browseSessions(10)).toEqual([]);
});

test('持久化:回填 —— 清空 fts 后重开仍可搜', () => {
  // 用临时文件 DB(非 :memory:),以便重开
  const tmp = mkdtempSync(join(tmpdir(), 'hermes-fts-'));
  const path = join(tmp, 's.db');
  const d1 = new SessionDB(path);
  const s = d1.createSession();
  d1.appendMessage(s.id, { role: 'user', content: 'BACKFILLWORD 回填测试内容' });
  // 模拟"升级前未索引":清空 fts 表
  d1.rawExec("DELETE FROM messages_fts");
  expect(d1.searchMessages('"BACKFILLWORD"', 10)).toEqual([]); // 清空后查不到
  d1.close();
  const d2 = new SessionDB(path); // 重开 → 构造回填
  expect(d2.searchMessages('"BACKFILLWORD"', 10).length).toBeGreaterThan(0);
  d2.close();
  rmSync(tmp, { recursive: true, force: true });
});
```
> 测试文件顶部需要 `mkdtempSync, rmSync` from 'node:fs'、`tmpdir` from 'node:os'、`join` from 'node:path'。若已存在 `beforeEach` 创建 `db = new SessionDB(':memory:')`,沿用之;持久化测试自建临时文件 DB。
> 「删除消息后不再命中」与回填测试都需要一个执行任意 SQL 的入口:在 SessionDB 加一个**仅测试/内部用**的 `rawExec(sql: string): void`(直接 `this.db.exec(sql)`)。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/core/src/session-db.test.ts`
Expected: FAIL（searchMessages/browseSessions/rawExec 不存在）

- [ ] **Step 3: 改 session-db.ts —— SCHEMA + 回填 + 方法**

READ 现有 `packages/core/src/session-db.ts`。

(a) 在 `SCHEMA` 常量末尾追加 FTS 表与触发器:
```sql
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
```

(b) 在构造函数 `this.db.exec(SCHEMA)` 之后调用回填:
```ts
    this.backfillFts();
```
并新增私有方法:
```ts
  private backfillFts(): void {
    this.db.exec(
      `INSERT INTO messages_fts(rowid, content)
       SELECT id, COALESCE(content,'') FROM messages
       WHERE role IN ('user','assistant')
         AND id NOT IN (SELECT rowid FROM messages_fts)`,
    );
  }
```

(c) 新增导出类型 + 两个方法 + rawExec:
```ts
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
```
在类内:
```ts
  searchMessages(query: string, limit = 30): SearchHit[] {
    const rows = this.db.prepare(
      `SELECT m.session_id AS sessionId, m.id AS messageId, m.role AS role,
              m.created_at AS createdAt,
              snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    ).all(query, limit) as SearchHit[];
    return rows;
  }

  browseSessions(limit = 10): SessionBrief[] {
    const rows = this.db.prepare(
      `SELECT s.id AS id, s.started_at AS startedAt,
              COALESCE((SELECT content FROM messages
                        WHERE session_id = s.id AND role = 'user'
                        ORDER BY seq LIMIT 1), '') AS preview
       FROM sessions s
       ORDER BY s.started_at DESC
       LIMIT ?`,
    ).all(limit) as SessionBrief[];
    return rows;
  }

  /** 仅供测试/内部维护使用:执行任意 SQL。 */
  rawExec(sql: string): void {
    this.db.exec(sql);
  }
```
> 注:`snippet()` 列索引 0 = fts 的 `content` 列。`messages_fts.rowid = m.id`(标准 fts5,rowid 即 messages.id)。better-sqlite3 的 `.all()` 返回的行字段名用 SQL 里的 AS 别名,直接 as 成接口类型即可(类型断言)。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/core/src/session-db.test.ts`
Expected: PASS（原 session-db 测试 + 新增全过）

- [ ] **Step 5: 导出 + 全量 + typecheck + 提交**

`packages/core/src/index.ts` 已 `export * from './session-db.js'`(SearchHit/SessionBrief 随之导出),无需改。
Run: `pnpm --filter @hermes/core exec tsc --noEmit`(干净)
Run: `pnpm vitest run`(125 + 新增 ~7 = ~132)
```bash
git add -A
git commit -m "feat(core): SessionDB FTS5 trigram + 回填 + searchMessages/browseSessions"
```

---

## Task 2:sanitizeFtsQuery

**Files:**
- Create: `packages/tools/src/fts-query.ts`, `packages/tools/src/fts-query.test.ts`
- Modify: `packages/tools/src/index.ts`

- [ ] **Step 1: 写失败测试**

`packages/tools/src/fts-query.test.ts`:
```ts
import { test, expect } from 'vitest';
import { sanitizeFtsQuery } from './fts-query.js';

test('普通词包裹为字面短语', () => {
  expect(sanitizeFtsQuery('pnpm')).toBe('"pnpm"');
});

test('双引号转义为 ""', () => {
  expect(sanitizeFtsQuery('a"b')).toBe('"a""b"');
});

test('布尔操作符当字面(不解析)', () => {
  expect(sanitizeFtsQuery('foo OR bar')).toBe('"foo OR bar"');
});

test('中文原样包裹', () => {
  expect(sanitizeFtsQuery('中文搜索')).toBe('"中文搜索"');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/tools/src/fts-query.test.ts`

- [ ] **Step 3: 实现**

`packages/tools/src/fts-query.ts`:
```ts
/**
 * 把用户查询转成 FTS5 字面短语:整体用双引号包裹,内部双引号转义为 ""。
 * 这样彻底绕开 FTS5 的 AND/OR/NOT/*/() 等操作符解析,杜绝注入。
 * 配合 trigram tokenizer 做子串匹配(调用方需保证查询 ≥3 字符)。
 */
export function sanitizeFtsQuery(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}
```

- [ ] **Step 4: 运行确认通过 + 导出 + 提交**

Run: `pnpm vitest run packages/tools/src/fts-query.test.ts`（4 通过）
在 `packages/tools/src/index.ts` 追加:`export * from './fts-query.js';`
Run: `pnpm --filter @hermes/tools exec tsc --noEmit`(干净)
```bash
git add -A
git commit -m "feat(tools): sanitizeFtsQuery(FTS5 字面短语转义)"
```

---

## Task 3:ToolContext.sessionDb + search toolset

**Files:**
- Modify: `packages/tools/src/registry.ts`, `packages/tools/src/toolsets.ts`, `packages/tools/src/toolsets.test.ts`

- [ ] **Step 1: 写失败 toolset 测试**

在 `packages/tools/src/toolsets.test.ts` 追加:
```ts
test('search toolset 存在且 core 包含它', () => {
  expect(Object.keys(TOOLSETS)).toContain('search');
  expect(resolveToolset('search')).toEqual(['session_search']);
  expect(resolveToolset('core')).toContain('session_search');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/tools/src/toolsets.test.ts`

- [ ] **Step 3: 改 toolsets.ts**

READ 现有 toolsets.ts。新增 search 分组,并把 'search' 加入 core.includes(REPLACE 数组,不重复):
```ts
  search: {
    description: '会话历史搜索',
    tools: ['session_search'],
  },
  core: {
    description: '核心工具集',
    includes: ['file', 'terminal', 'memory', 'search'],
  },
```
(core.includes 当前是 `['file','terminal','memory']` → 加 `'search'`。)

- [ ] **Step 4: ToolContext 加 sessionDb**

`packages/tools/src/registry.ts`:
- 在现有 `import type { MemoryStore } from '@hermes/core';` 处一并 import `SessionDB`:`import type { MemoryStore, SessionDB } from '@hermes/core';`
- `ToolContext` 接口加:`sessionDb?: SessionDB;`

> 循环依赖:core 不依赖 tools,type-only import 安全。

- [ ] **Step 5: 运行确认通过 + 全量 + typecheck + 提交**

Run: `pnpm vitest run packages/tools/src/toolsets.test.ts`
Run: `pnpm --filter @hermes/tools exec tsc --noEmit`(干净)
Run: `pnpm vitest run`(全绿)
```bash
git add -A
git commit -m "feat(tools): search toolset + ToolContext.sessionDb"
```

---

## Task 4:session_search 工具

**Files:**
- Create: `packages/tools/src/builtin/session-search.ts`, `packages/tools/src/builtin/session-search.test.ts`
- Modify: `packages/tools/src/builtin/index.ts`

- [ ] **Step 1: 写失败测试**

`packages/tools/src/builtin/session-search.test.ts`:
```ts
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
  // 同一会话两条命中,只应出现一次该会话短码
  const code = a.id.slice(0, 8);
  const occurrences = out.split(code).length - 1;
  expect(occurrences).toBe(1);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/tools/src/builtin/session-search.test.ts`

- [ ] **Step 3: 实现 session-search.ts**

`packages/tools/src/builtin/session-search.ts`:
```ts
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { sanitizeFtsQuery } from '../fts-query.js';

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export const sessionSearchTool = defineTool({
  name: 'session_search',
  description:
    '搜索过往会话历史。给 query 全文搜索(子串,≥3 字符,支持中文);省略 query 则浏览最近会话。用于回忆之前聊过/做过什么。',
  toolset: 'search',
  schema: z.object({
    query: z.string().optional().describe('搜索词(≥3 字符);省略=浏览最近会话'),
    limit: z.number().optional().describe('结果数,默认 10'),
  }),
  handler: async ({ query, limit = 10 }, ctx) => {
    if (!ctx.sessionDb) return '会话搜索不可用。';
    if (query === undefined || query.trim() === '') {
      const briefs = ctx.sessionDb.browseSessions(limit);
      if (briefs.length === 0) return '暂无历史会话。';
      return briefs
        .map((b) => `· ${b.id.slice(0, 8)} ${new Date(b.startedAt).toISOString()}  ${truncate(b.preview, 80)}`)
        .join('\n');
    }
    if (query.trim().length < 3) return '搜索词至少 3 个字符。';
    const hits = ctx.sessionDb.searchMessages(sanitizeFtsQuery(query), limit * 3);
    const bySession = new Map<string, (typeof hits)[number]>();
    for (const h of hits) {
      if (!bySession.has(h.sessionId)) bySession.set(h.sessionId, h);
    }
    const top = [...bySession.values()].slice(0, limit);
    if (top.length === 0) return '无匹配。';
    return top
      .map((h) => `· ${h.sessionId.slice(0, 8)} [${h.role}] ${new Date(h.createdAt).toISOString()}\n  ${h.snippet}`)
      .join('\n');
  },
});
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/tools/src/builtin/session-search.test.ts`
Expected: PASS（6）

- [ ] **Step 5: 注册**

修改 `packages/tools/src/builtin/index.ts`:import `sessionSearchTool`,加入 `builtinTools` 数组,在 `registerBuiltins` 加 `registry.register(sessionSearchTool);`。

- [ ] **Step 6: 全量 + typecheck + 提交**

Run: `pnpm vitest run`(全绿)
Run: `pnpm --filter @hermes/tools exec tsc --noEmit`(干净)
```bash
git add -A
git commit -m "feat(tools): session_search 工具(discovery + browse)+ 注册"
```

---

## Task 5:CLI 接线 + 端到端 + 文档

**Files:**
- Modify: `apps/cli/src/repl.ts`, `README.md`, `docs/ROADMAP.md`

- [ ] **Step 1: 改 repl.ts**

READ `apps/cli/src/repl.ts`。找到每轮 `runConversation(deps, session.id, line, { ...ctx, signal: controller.signal, approval: guard, memory: deps.memory })`,加上 `sessionDb: deps.db`:
```ts
runConversation(deps, session.id, line, { ...ctx, signal: controller.signal, approval: guard, memory: deps.memory, sessionDb: deps.db })
```
（`deps.db` 是 SessionDB,已存在;main.ts 无需改。)

- [ ] **Step 2: typecheck + 冒烟 + 全量**

Run: `pnpm --filter @hermes/cli exec tsc --noEmit`(干净)
Run: `GLM_API_KEY= pnpm --filter @hermes/cli exec tsx src/main.ts`(打印缺 key 并退出 1,不挂起)
Run: `pnpm -r exec tsc --noEmit`(全包干净)
Run: `pnpm vitest run`(全绿)

- [ ] **Step 3: 手动验证(无需 key)**

临时脚本验证端到端(或 `apps/cli/src/_smoke_p3b.ts` 跑后删):
```ts
import { SessionDB } from '@hermes/core';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const d = mkdtempSync(join(tmpdir(), 'smoke-ss-'));
const db = new SessionDB(join(d, 's.db'));
const s = db.createSession();
db.appendMessage(s.id, { role: 'user', content: '我们讨论了 pnpm workspace 的配置' });
console.log('search pnpm:', JSON.stringify(db.searchMessages('"pnpm"', 5)));
console.log('search 中文:', JSON.stringify(db.searchMessages('"workspace"', 5)));
console.log('browse:', JSON.stringify(db.browseSessions(5)));
```
Expected:search 命中含 snippet;browse 返回该会话 preview。报告输出,删除临时文件。

- [ ] **Step 4: 更新 README + ROADMAP**

`README.md`:
- `@hermes/tools` 工具列表加 `session_search`;toolset 列表加 `search`。
- 在「记忆 (Memory)」之后或合适处加一小节「会话搜索 (Session Search)」:`session_search` 工具对历史会话做全文搜索(trigram,支持中文子串,≥3 字符);省略 query 浏览最近会话。
- 「已知限制」更新:session_search 已支持;技能系统仍未实现(后续阶段)。
- 顶部「当前状态」可更新到「阶段 3b(会话搜索)✅」并在分阶段列表加一行。

`docs/ROADMAP.md`:
- 阶段总览表:3b 行改为「3b session_search ✅ 完成」;技能拆出单列一行(如「技能系统 ⏸️ 计划」)。
- 阶段 3 小节:3b 标 session_search ✅(列已做:FTS5 trigram + 触发器 + 回填 + searchMessages/browseSessions + session_search 工具 + sanitizeFtsQuery + search toolset);技能仍 ⏸️。
- 「已知限制」更新:会话全文搜索已支持;无技能系统。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(cli)+docs: 注入 sessionDb + 阶段3b README/ROADMAP 与端到端验证"
```

---

## 完成定义(阶段 3b DoD)

- [ ] 新测试全绿(session-db FTS ~7 + fts-query 4 + toolsets 1 + session-search 工具 6 = ~18 新),原 125 无回归
- [ ] `pnpm -r exec tsc --noEmit` 全包干净
- [ ] 手动:search 命中(含中文)+ browse 验证通过
- [ ] README + ROADMAP 更新(3b session_search ✅)
- [ ] 全部提交到 git
