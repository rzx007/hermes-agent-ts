# Hermes Agent TS — 阶段 3b:会话全文搜索(session_search) 设计

- **日期**: 2026-06-21
- **状态**: 设计阶段
- **源项目**: `D:/code/personal-project/hermes-agent`(hermes_state.py FTS5, tools/session_search_tool.py)
- **前置**: 阶段 1/2/2.5/3a 已完成并合并。当前在 `phase3b-session-search` 分支,基线 125 测试全绿。

---

## 1. 背景与目标

agent 已能跨会话记忆(3a),但只能"想起"主动记下的条目;无法检索**过往对话原文**。本阶段加 `session_search` 工具:对 SessionDB 的历史消息做 FTS5 全文搜索,让 agent 能回忆"我们之前聊过/做过什么"。

原项目 `session_search` 较大(双 FTS 表、四种模式 DISCOVERY/SCROLL/READ/BROWSE、bookend、trust_score 排序、CJK trigram + LIKE 回退)。本阶段做**自包含精简核心**。技能系统(原 3b 另一半)**另立独立阶段**,不在此。

---

## 2. 范围

### 2.1 做(MVP)
- SessionDB 加单张 `messages_fts`(`tokenize='trigram'`)虚拟表 + INSERT/DELETE/UPDATE 触发器(只索引 user/assistant 消息)。
- **回填**:构造时幂等回填未索引的历史消息(处理已存在的 sessions.db)。
- `SessionDB.searchMessages(query, limit)`:FTS5 MATCH + `snippet()`,返回命中(sessionId/messageId/role/createdAt/snippet),按 rank 排序。
- `SessionDB.browseSessions(limit)`:最近会话(id/startedAt/preview=首条 user 消息)。
- `sanitizeFtsQuery(raw)`:把查询当字面短语(双引号包裹+转义),杜绝 FTS5 注入。
- `session_search` 工具:**DISCOVERY**(给 query)+ **BROWSE**(无 query),会话级去重。
- 新 `search` toolset(并入 core);`ToolContext.sessionDb` 注入(沿用 memory/approval 模式)。

### 2.2 明确不做(推迟)
- 技能系统(独立阶段)。
- SCROLL/READ 窗口模式、bookend 头尾、时间/相关性多排序选项。
- 会话血缘去重(parent_session_id 恒 null,无分支)。
- subagent/tool 会话排除(暂无此类会话)。
- 标准+trigram 双表(只用 trigram 单表,兼顾中英文子串)。
- 索引 tool_calls / tool 消息内容(只索引 user/assistant 的 content)。

### 2.3 向后兼容
`ToolContext.sessionDb` 可选;不注入时工具返回"不可用"。FTS 表/触发器用 `IF NOT EXISTS`,对现有 DB 安全;回填幂等。现有 125 测试不受影响。

### 2.4 并发备忘(本阶段不实现)
FTS 触发器在写者同一事务内执行,不引入新锁。多进程/多会话并行的 DB 加固(busy_timeout、SQLITE_BUSY 重试、共享单例按用户拆分)属**网关阶段**,见 ROADMAP。

---

## 3. 文件结构

```
packages/core/src/
  session-db.ts          (改) FTS5 schema + 触发器 + 回填 + searchMessages + browseSessions
  session-db.test.ts     (改) FTS 测试
packages/tools/src/
  fts-query.ts            (新) sanitizeFtsQuery
  fts-query.test.ts       (新)
  registry.ts             (改) ToolContext.sessionDb?: SessionDB
  toolsets.ts             (改) 'search' toolset + core.includes 加 search
  toolsets.test.ts        (改)
  builtin/session-search.ts      (新) session_search 工具
  builtin/session-search.test.ts (新)
  builtin/index.ts        (改) 注册 session_search
apps/cli/src/repl.ts      (改) 每轮 ctx 注入 sessionDb: deps.db
```
依赖方向不变。main.ts 无需改(deps.db 已存在)。

---

## 4. SessionDB FTS5(`packages/core/src/session-db.ts`)

### 4.1 SCHEMA 追加
单张 trigram 表 + 三触发器(只索引 user/assistant):
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
标准(非 external-content)fts5 表,`DELETE FROM messages_fts WHERE rowid=?` 合法。仅索引 `content`。

### 4.2 回填(构造时,幂等)
```sql
INSERT INTO messages_fts(rowid, content)
  SELECT id, COALESCE(content,'') FROM messages
  WHERE role IN ('user','assistant')
    AND id NOT IN (SELECT rowid FROM messages_fts);
```
在 `new SessionDB()` 构造、SCHEMA exec 之后执行一次。处理升级前已有的消息。

### 4.3 新方法
```ts
export interface SearchHit {
  sessionId: string; messageId: number; role: string; createdAt: number; snippet: string;
}
searchMessages(query: string, limit?: number): SearchHit[];
// SELECT m.session_id, m.id, m.role, m.created_at,
//        snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet
// FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
// WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?
// 注:query 由调用方 sanitize;limit 默认 30(工具再按会话归并)。

export interface SessionBrief { id: string; startedAt: number; preview: string }
browseSessions(limit?: number): SessionBrief[];
// SELECT s.id, s.started_at,
//   (SELECT content FROM messages WHERE session_id=s.id AND role='user' ORDER BY seq LIMIT 1) AS preview
// FROM sessions s ORDER BY started_at DESC LIMIT ?
// preview 为 null 时返回空串。
```

> 说明:`sessions.title` 当前恒 null(CLI 未设标题),故用**首条 user 消息**作人类可读预览。

---

## 5. FTS 查询转义(`packages/tools/src/fts-query.ts`)

trigram 表把查询当**字面短语**最安全,绕开 FTS5 操作符解析:
```ts
export function sanitizeFtsQuery(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}
```
- 工具层在调用前检查 `raw.trim().length < 3`(trigram 需 ≥3 字符)→ 友好提示,不查。
- 例:`foo OR bar` → `"foo OR bar"`(字面搜,不解析为布尔)。

---

## 6. session_search 工具(`packages/tools/src/builtin/session-search.ts`)

```ts
export const sessionSearchTool = defineTool({
  name: 'session_search',
  description: '搜索过往会话历史。给 query 全文搜索(子串,≥3 字符,支持中文);省略 query 则浏览最近会话。用于回忆之前聊过/做过什么。',
  toolset: 'search',
  schema: z.object({
    query: z.string().optional().describe('搜索词(≥3 字符);省略=浏览最近会话'),
    limit: z.number().optional().describe('结果数,默认 10'),
  }),
  handler: async ({ query, limit = 10 }, ctx) => {
    if (!ctx.sessionDb) return '会话搜索不可用。';
    if (query === undefined || query.trim() === '') {
      // BROWSE
      const briefs = ctx.sessionDb.browseSessions(limit);
      if (briefs.length === 0) return '暂无历史会话。';
      return briefs.map((b) => `· ${b.id.slice(0,8)} ${new Date(b.startedAt).toISOString()}  ${truncate(b.preview, 80)}`).join('\n');
    }
    // DISCOVERY
    if (query.trim().length < 3) return '搜索词至少 3 个字符。';
    const hits = ctx.sessionDb.searchMessages(sanitizeFtsQuery(query), limit * 3);
    const bySession = new Map<string, (typeof hits)[number]>();
    for (const h of hits) if (!bySession.has(h.sessionId)) bySession.set(h.sessionId, h);
    const top = [...bySession.values()].slice(0, limit);
    if (top.length === 0) return '无匹配。';
    return top.map((h) => `· ${h.sessionId.slice(0,8)} [${h.role}] ${new Date(h.createdAt).toISOString()}\n  ${h.snippet}`).join('\n');
  },
});
// truncate(s, n): 超长加省略号(本文件内私有助手)。
```
- `searchMessages` 收已 sanitize 的 query;会话去重在工具层(按 sessionId 归并,保留首个命中)。

### 6.1 toolset + ctx
- `toolsets.ts`:`search: { description:'会话历史搜索', tools:['session_search'] }`;`core.includes` 追加 `'search'`。
- `registry.ts`:`ToolContext.sessionDb?: SessionDB`(`import type { SessionDB } from '@hermes/core'`)。
- `builtin/index.ts`:import + builtinTools + registerBuiltins。
- `repl.ts`:每轮注入 `sessionDb: deps.db`。

---

## 7. 错误处理

| 情况 | 处理 |
|------|------|
| 无 `ctx.sessionDb` | 返回「会话搜索不可用」 |
| query < 3 字符 | 返回「搜索词至少 3 个字符」 |
| 无匹配 / 无历史 | 「无匹配」/「暂无历史会话」 |
| FTS5 异常(被转义挡住,理论不至) | searchMessages throw → registry 回灌 |
| 回填重复 | `id NOT IN (...)` 幂等;触发器 `IF NOT EXISTS` |

---

## 8. 测试(Vitest)

| 测试 | 覆盖 |
|------|------|
| `session-db.test.ts`(补) | searchMessages 命中含 snippet;**中文子串**命中(trigram,**查询必须 ≥3 个汉字**,如索引 `我喜欢用中文搜索`、查 `中文搜`——2 字如 `子串` 既无 trigram 也被 <3 守卫挡掉);tool/system 消息不被索引(不出现在结果);删除消息后不再命中;browseSessions 时间倒序 + preview=首条 user;空库 browse 为空;**回填**:`DELETE FROM messages_fts` 后重开 SessionDB → 搜索仍命中;持久化(重开同文件可搜) |
| `fts-query.test.ts` | 双引号转义;布尔词当字面 |
| `session-search.test.ts`(工具) | discovery 命中+格式化;browse 无 query;query<3 提示;无 ctx.sessionDb 不可用;无匹配提示;多会话按 sessionId 去重 |
| `toolsets.test.ts`(补) | search toolset 存在;core 含 search |

文件测试用 `:memory:` 或临时文件 SessionDB。

### 8.1 完成定义(DoD)
- 新测试全绿 + 原 125 无回归 + 全包 `tsc --noEmit` 干净。
- 手动 `pnpm cli`:让模型「搜索之前关于 pnpm 的对话」→ `⚙ session_search(...)` 返回历史命中(用已有 sessions.db,回填生效)。
- README + ROADMAP 更新(3b session_search ✅;技能另立阶段)。

---

## 9. 后续衔接点
- 技能系统:独立阶段(技能加载/工具/注入/自改进)。
- session_search 增强:SCROLL/READ 窗口、bookend、排序选项、subagent/tool 会话排除、按 source/时间过滤。
- 网关阶段:多进程 DB 加固(busy_timeout/重试)、共享单例按用户拆分。
