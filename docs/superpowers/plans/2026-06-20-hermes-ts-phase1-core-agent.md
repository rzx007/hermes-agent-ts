# Hermes TS 阶段 1：核心代理（Core Agent MVP）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 TypeScript 搭出一个能跑通「对话 → 工具调用 → 多轮循环 → 会话持久化」的最小可用 AI 代理，作为完整复刻 hermes-agent 的地基。

**Architecture:** pnpm workspace monorepo，4 个库包（core / providers / tools / agent）+ 1 个应用（cli），单向依赖 `core ← providers ← agent ← cli`，`tools` 也被 `agent` 依赖。Provider 始终以流式 AsyncIterable 产出、由 `aggregate` 收口完整结果；ConversationLoop 产出 LoopEvent 事件流，CLI 仅消费事件、不碰底层。

**Tech Stack:** Node 20+ / TypeScript(strict) / pnpm / tsx / tsup / better-sqlite3 / Zod + zod-to-json-schema / Vitest / pino / openai SDK。联调模型用 GLM/智谱 Coding Plan（OpenAI 兼容端点）。

**Spec:** `docs/superpowers/specs/2026-06-20-hermes-ts-phase1-core-agent-design.md`

---

## 文件结构总览

| 包 / 应用 | 文件 | 职责 |
|-----------|------|------|
| 根 | `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.env.example`, `vitest.config.ts` | monorepo 配置、共享 tsconfig、测试配置 |
| `@hermes/core` | `src/types.ts` | Message/ToolCall/Session/Role 等核心类型 |
| | `src/paths.ts` | `~/.hermes` 目录解析与创建 |
| | `src/config.ts` | 加载 config + env 回退 |
| | `src/logging.ts` | pino logger 封装 |
| | `src/session-db.ts` | SessionDB（better-sqlite3） |
| | `src/index.ts` | 包导出 |
| `@hermes/providers` | `src/provider.ts` | Provider/Completion* 接口定义 |
| | `src/openai-compatible.ts` | OpenAI 兼容客户端（流式 + 聚合 + 格式互转） |
| | `src/glm.ts` | GLM 薄封装 + createProvider 工厂 |
| | `src/index.ts` | 包导出 |
| `@hermes/tools` | `src/registry.ts` | ToolRegistry（注册 / schema / 校验调用） |
| | `src/builtin/read-file.ts` | read_file 工具 |
| | `src/builtin/write-file.ts` | write_file 工具 |
| | `src/builtin/terminal.ts` | terminal 工具（local 后端） |
| | `src/builtin/index.ts` | 注册所有内置工具 |
| | `src/index.ts` | 包导出 |
| `@hermes/agent` | `src/events.ts` | LoopEvent 类型 |
| | `src/system-prompt.ts` | system prompt 构建 |
| | `src/conversation-loop.ts` | runConversation 核心循环 |
| | `src/index.ts` | 包导出 |
| `@hermes/cli` | `src/main.ts` | 装配依赖 + 入口 |
| | `src/repl.ts` | readline REPL + 事件渲染 |

---

## Task 0：Monorepo 脚手架

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.env.example`, `vitest.config.ts`

- [ ] **Step 1: 创建 workspace 配置**

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

- [ ] **Step 2: 创建根 package.json**

`package.json`:
```json
{
  "name": "hermes-agent-ts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r exec tsc --noEmit",
    "cli": "pnpm --filter @hermes/cli dev"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsx": "^4.16.0",
    "tsup": "^8.1.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.14.0"
  }
}
```

- [ ] **Step 3: 创建共享 tsconfig**

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true
  }
}
```

- [ ] **Step 4: 创建 vitest 配置与 .env.example**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globals: false, include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'] },
});
```

`.env.example`:
```
# GLM / 智谱 Coding Plan（OpenAI 兼容端点）
GLM_API_KEY=your-key-here
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
HERMES_MODEL=glm-4.6
# HERMES_HOME=  # 可选，默认 ~/.hermes
```

- [ ] **Step 5: 安装根依赖并提交**

Run: `pnpm install`
Expected: 安装成功，生成 `pnpm-lock.yaml`

```bash
git add -A
git commit -m "chore: monorepo 脚手架（pnpm workspace + tsconfig + vitest）"
```

---

## Task 1：@hermes/core 包初始化 + 核心类型

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/types.ts`, `packages/core/src/index.ts`

- [ ] **Step 1: 创建 core 包配置**

`packages/core/package.json`:
```json
{
  "name": "@hermes/core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "pino": "^9.0.0",
    "uuid": "^10.0.0",
    "yaml": "^2.4.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/uuid": "^10.0.0"
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2: 写核心类型**

`packages/core/src/types.ts`:
```ts
export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // 原始 JSON 字符串
}

export interface Message {
  role: Role;
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface Session {
  id: string;
  userId: string;
  title: string | null;
  source: string;
  startedAt: number;
  endedAt: number | null;
  parentSessionId: string | null;
  modelConfig: Record<string, unknown>;
}

export interface CreateSessionOpts {
  userId?: string;
  title?: string | null;
  source?: string;
  modelConfig?: Record<string, unknown>;
}
```

- [ ] **Step 3: 临时 index 导出（后续任务追加）**

`packages/core/src/index.ts`:
```ts
export * from './types.js';
```

- [ ] **Step 4: 安装并 typecheck**

Run: `pnpm install && pnpm --filter @hermes/core exec tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(core): 包初始化与核心类型定义"
```

---

## Task 2：paths + config + logging

**Files:**
- Create: `packages/core/src/paths.ts`, `packages/core/src/paths.test.ts`, `packages/core/src/config.ts`, `packages/core/src/logging.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: 写 paths 失败测试**

`packages/core/src/paths.test.ts`:
```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run packages/core/src/paths.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 paths**

`packages/core/src/paths.ts`:
```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export function getHermesHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERMES_HOME) return env.HERMES_HOME;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return join(home, '.hermes');
}

export function ensureHermesHome(env: NodeJS.ProcessEnv = process.env): string {
  const dir = getHermesHome(env);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sessionDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getHermesHome(env), 'sessions.db');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run packages/core/src/paths.test.ts`
Expected: PASS

- [ ] **Step 5: 实现 config 与 logging**

`packages/core/src/config.ts`:
```ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { getHermesHome } from './paths.js';

export interface HermesConfig {
  provider: string;     // 'glm'
  model: string;        // 'glm-4.6'
  apiKey: string;
  baseUrl: string;
  maxIterations: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HermesConfig {
  const file = join(getHermesHome(env), 'config.yaml');
  const fromFile = existsSync(file) ? (parse(readFileSync(file, 'utf8')) ?? {}) : {};
  const provider = env.HERMES_PROVIDER ?? fromFile.provider ?? 'glm';
  return {
    provider,
    model: env.HERMES_MODEL ?? fromFile.model ?? 'glm-4.6',
    apiKey: env.GLM_API_KEY ?? fromFile.apiKey ?? '',
    baseUrl: env.GLM_BASE_URL ?? fromFile.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4',
    maxIterations: Number(env.HERMES_MAX_ITERATIONS ?? fromFile.maxIterations ?? 25),
  };
}
```

`packages/core/src/logging.ts`:
```ts
import pino, { type Logger } from 'pino';

export type { Logger };

export function createLogger(name = 'hermes'): Logger {
  return pino({
    name,
    level: process.env.HERMES_LOG_LEVEL ?? 'info',
    transport: process.env.HERMES_LOG_PRETTY
      ? { target: 'pino-pretty' }
      : undefined,
  });
}
```

- [ ] **Step 6: 更新 index 导出**

`packages/core/src/index.ts`:
```ts
export * from './types.js';
export * from './paths.js';
export * from './config.js';
export * from './logging.js';
```

- [ ] **Step 7: 运行全部 core 测试 + 提交**

Run: `pnpm vitest run packages/core`
Expected: PASS

```bash
git add -A
git commit -m "feat(core): paths/config/logging"
```

---

## Task 3：SessionDB

**Files:**
- Create: `packages/core/src/session-db.ts`, `packages/core/src/session-db.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: 写失败测试**

`packages/core/src/session-db.test.ts`:
```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/core/src/session-db.test.ts`
Expected: FAIL（SessionDB 不存在）

- [ ] **Step 3: 实现 SessionDB**

`packages/core/src/session-db.ts`:
```ts
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
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/core/src/session-db.test.ts`
Expected: PASS（5 个测试全过）

- [ ] **Step 5: 更新 index + 提交**

在 `packages/core/src/index.ts` 追加：
```ts
export * from './session-db.js';
```

```bash
git add -A
git commit -m "feat(core): SessionDB（SQLite 会话与消息持久化）"
```

---

## Task 4：@hermes/providers 接口定义

**Files:**
- Create: `packages/providers/package.json`, `packages/providers/tsconfig.json`, `packages/providers/src/provider.ts`, `packages/providers/src/index.ts`

- [ ] **Step 1: 创建包配置**

`packages/providers/package.json`:
```json
{
  "name": "@hermes/providers",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
  "scripts": { "build": "tsup src/index.ts --format esm --dts --clean" },
  "dependencies": {
    "@hermes/core": "workspace:*",
    "openai": "^4.56.0"
  }
}
```

`packages/providers/tsconfig.json`: 同 core 的 tsconfig（extends base，outDir dist，rootDir src）。

- [ ] **Step 2: 写接口**

`packages/providers/src/provider.ts`:
```ts
import type { Message, ToolCall } from '@hermes/core';

export interface ToolSchema {
  name: string;
  description: string;
  parameters: object; // JSON Schema
}

export interface CompletionRequest {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  signal?: AbortSignal;
}

export interface CompletionChunk {
  contentDelta?: string;
  toolCallDelta?: { index: number; id?: string; name?: string; argsDelta?: string };
}

export interface CompletionResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface Provider {
  readonly name: string;
  complete(req: CompletionRequest): AsyncIterable<CompletionChunk>;
  aggregate(chunks: AsyncIterable<CompletionChunk>): Promise<CompletionResult>;
}
```

- [ ] **Step 3: index 导出**

`packages/providers/src/index.ts`:
```ts
export * from './provider.js';
```

- [ ] **Step 4: 安装 + typecheck + 提交**

Run: `pnpm install && pnpm --filter @hermes/providers exec tsc --noEmit`
Expected: 无错误

```bash
git add -A
git commit -m "feat(providers): Provider 接口定义"
```

---

## Task 5：OpenAI 兼容客户端（聚合逻辑优先 TDD）

**Files:**
- Create: `packages/providers/src/openai-compatible.ts`, `packages/providers/src/openai-compatible.test.ts`
- Modify: `packages/providers/src/index.ts`

> 关键风险点：流式 tool_call 分片需按 `index` 累积 id/name/arguments；循环退出判据以「是否解析出 toolCalls」为主，不能只看 finishReason（GLM 可能返回 'stop'）。先用纯函数把聚合逻辑测透。

- [ ] **Step 1: 写聚合逻辑失败测试**

`packages/providers/src/openai-compatible.test.ts`:
```ts
import { test, expect } from 'vitest';
import { aggregateChunks } from './openai-compatible.js';
import type { CompletionChunk } from './provider.js';

async function* gen(chunks: CompletionChunk[]) { for (const c of chunks) yield c; }

test('聚合纯文本增量', async () => {
  const r = await aggregateChunks(gen([
    { contentDelta: 'Hel' }, { contentDelta: 'lo' },
  ]));
  expect(r.content).toBe('Hello');
  expect(r.toolCalls).toEqual([]);
});

test('按 index 累积分片的 tool_call', async () => {
  const r = await aggregateChunks(gen([
    { toolCallDelta: { index: 0, id: 'c1', name: 'read_file' } },
    { toolCallDelta: { index: 0, argsDelta: '{"pa' } },
    { toolCallDelta: { index: 0, argsDelta: 'th":"a"}' } },
  ]));
  expect(r.toolCalls).toEqual([{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }]);
});

test('多个并行 tool_call 按 index 分别累积', async () => {
  const r = await aggregateChunks(gen([
    { toolCallDelta: { index: 0, id: 'c1', name: 'read_file', argsDelta: '{}' } },
    { toolCallDelta: { index: 1, id: 'c2', name: 'write_file', argsDelta: '{}' } },
  ]));
  expect(r.toolCalls.map((t) => t.name)).toEqual(['read_file', 'write_file']);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/providers/src/openai-compatible.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现客户端 + 聚合**

`packages/providers/src/openai-compatible.ts`:
```ts
import OpenAI from 'openai';
import type {
  Provider, CompletionRequest, CompletionChunk, CompletionResult, ToolSchema,
} from './provider.js';
import type { Message } from '@hermes/core';

export interface OpenAICompatibleOpts {
  name: string;
  apiKey: string;
  baseURL: string;
}

// 纯函数：把流式增量聚合成完整结果（核心，单测覆盖）
export async function aggregateChunks(
  chunks: AsyncIterable<CompletionChunk>,
  finishReasonRef?: { value: string },
): Promise<CompletionResult> {
  let content = '';
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  for await (const c of chunks) {
    if (c.contentDelta) content += c.contentDelta;
    if (c.toolCallDelta) {
      const d = c.toolCallDelta;
      const cur = calls.get(d.index) ?? { id: '', name: '', arguments: '' };
      if (d.id) cur.id = d.id;
      if (d.name) cur.name = d.name;
      if (d.argsDelta) cur.arguments += d.argsDelta;
      calls.set(d.index, cur);
    }
  }
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return {
    content: content || null,
    toolCalls,
    finishReason: finishReasonRef?.value ?? (toolCalls.length ? 'tool_calls' : 'stop'),
  };
}

function toOpenAIMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((t) => ({
              id: t.id, type: 'function' as const,
              function: { name: t.name, arguments: t.arguments },
            })) }
          : {}),
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content ?? '', tool_call_id: m.toolCallId! };
    }
    return { role: m.role, content: m.content ?? '' } as OpenAI.ChatCompletionMessageParam;
  });
}

function toOpenAITools(tools?: ToolSchema[]): OpenAI.ChatCompletionTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> },
  }));
}

export class OpenAICompatibleProvider implements Provider {
  readonly name: string;
  private client: OpenAI;

  constructor(opts: OpenAICompatibleOpts) {
    this.name = opts.name;
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  }

  async *complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    const stream = await this.client.chat.completions.create({
      model: req.model,
      messages: toOpenAIMessages(req.messages),
      tools: toOpenAITools(req.tools),
      stream: true,
    }, { signal: req.signal });

    for await (const part of stream) {
      const delta = part.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) yield { contentDelta: delta.content };
      for (const tc of delta.tool_calls ?? []) {
        yield {
          toolCallDelta: {
            index: tc.index,
            id: tc.id,
            name: tc.function?.name,
            argsDelta: tc.function?.arguments,
          },
        };
      }
    }
  }

  aggregate(chunks: AsyncIterable<CompletionChunk>): Promise<CompletionResult> {
    return aggregateChunks(chunks);
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/providers/src/openai-compatible.test.ts`
Expected: PASS

- [ ] **Step 5: index 导出 + 提交**

在 `packages/providers/src/index.ts` 追加 `export * from './openai-compatible.js';`

```bash
git add -A
git commit -m "feat(providers): OpenAI 兼容客户端与流式聚合"
```

---

## Task 6：GLM 封装 + createProvider 工厂

**Files:**
- Create: `packages/providers/src/glm.ts`
- Modify: `packages/providers/src/index.ts`

- [ ] **Step 1: 实现 glm + 工厂**

`packages/providers/src/glm.ts`:
```ts
import type { HermesConfig } from '@hermes/core';
import type { Provider } from './provider.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

export function createGLMProvider(config: HermesConfig): Provider {
  return new OpenAICompatibleProvider({
    name: 'glm', apiKey: config.apiKey, baseURL: config.baseUrl,
  });
}

export function createProvider(config: HermesConfig): Provider {
  switch (config.provider) {
    case 'glm':
      return createGLMProvider(config);
    default:
      throw new Error(`未知的 provider: ${config.provider}（阶段1仅支持 glm）`);
  }
}
```

- [ ] **Step 2: index 导出 + typecheck**

在 `packages/providers/src/index.ts` 追加 `export * from './glm.js';`

Run: `pnpm --filter @hermes/providers exec tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "feat(providers): GLM 封装与 createProvider 工厂"
```

---

## Task 7：@hermes/tools — ToolRegistry

**Files:**
- Create: `packages/tools/package.json`, `packages/tools/tsconfig.json`, `packages/tools/src/registry.ts`, `packages/tools/src/registry.test.ts`, `packages/tools/src/index.ts`

- [ ] **Step 1: 创建包配置**

`packages/tools/package.json`:
```json
{
  "name": "@hermes/tools",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
  "scripts": { "build": "tsup src/index.ts --format esm --dts --clean" },
  "dependencies": {
    "@hermes/core": "workspace:*",
    "@hermes/providers": "workspace:*",
    "zod": "^3.23.0",
    "zod-to-json-schema": "^3.23.0"
  }
}
```
`packages/tools/tsconfig.json`: extends base，outDir dist，rootDir src。

> 注：`@hermes/tools` 依赖 `@hermes/providers` 仅为复用 `ToolSchema` 类型。

- [ ] **Step 2: 写失败测试**

`packages/tools/src/registry.test.ts`:
```ts
import { test, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from './registry.js';
import { createLogger } from '@hermes/core';

const ctx = { cwd: process.cwd(), logger: createLogger('test') };

function makeRegistry() {
  const r = new ToolRegistry();
  r.register({
    name: 'echo', description: 'echo back', toolset: 'core',
    schema: z.object({ text: z.string() }),
    handler: async (a) => `echoed: ${a.text}`,
  });
  return r;
}

test('getSchemas 输出 JSON Schema', () => {
  const schemas = makeRegistry().getSchemas();
  expect(schemas[0]!.name).toBe('echo');
  expect(schemas[0]!.parameters).toMatchObject({ type: 'object' });
});

test('call 正常执行返回字符串', async () => {
  const out = await makeRegistry().call('echo', '{"text":"hi"}', ctx);
  expect(out).toBe('echoed: hi');
});

test('call 在 JSON 解析失败时返回错误文本（不抛）', async () => {
  const out = await makeRegistry().call('echo', '{bad json', ctx);
  expect(out.toLowerCase()).toContain('error');
});

test('call 在 Zod 校验失败时返回错误文本（不抛）', async () => {
  const out = await makeRegistry().call('echo', '{"text":123}', ctx);
  expect(out.toLowerCase()).toContain('error');
});

test('call 未知工具返回错误文本', async () => {
  const out = await makeRegistry().call('nope', '{}', ctx);
  expect(out.toLowerCase()).toContain('error');
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm install && pnpm vitest run packages/tools/src/registry.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现 registry**

`packages/tools/src/registry.ts`:
```ts
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Logger } from '@hermes/core';
import type { ToolSchema } from '@hermes/providers';

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  logger: Logger;
}

export interface ToolDef<T extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  toolset: string;
  schema: T;
  handler: (args: z.infer<T>, ctx: ToolContext) => Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register<T extends z.ZodTypeAny>(def: ToolDef<T>): void {
    this.tools.set(def.name, def as unknown as ToolDef);
  }

  has(name: string): boolean { return this.tools.has(name); }

  getSchemas(names?: string[]): ToolSchema[] {
    const defs = names
      ? names.map((n) => this.tools.get(n)).filter((d): d is ToolDef => !!d)
      : [...this.tools.values()];
    return defs.map((d) => ({
      name: d.name,
      description: d.description,
      parameters: zodToJsonSchema(d.schema, { target: 'openApi3' }) as object,
    }));
  }

  async call(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
    const def = this.tools.get(name);
    if (!def) return `Error: 未知工具 "${name}"`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs || '{}');
    } catch {
      return `Error: 工具 "${name}" 入参不是合法 JSON: ${rawArgs}`;
    }
    const result = def.schema.safeParse(parsed);
    if (!result.success) {
      return `Error: 工具 "${name}" 入参校验失败: ${result.error.message}`;
    }
    try {
      return await def.handler(result.data, ctx);
    } catch (e) {
      return `Error: 工具 "${name}" 执行失败: ${(e as Error).message}`;
    }
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run packages/tools/src/registry.test.ts`
Expected: PASS（5 个）

- [ ] **Step 6: index 导出 + 提交**

`packages/tools/src/index.ts`:
```ts
export * from './registry.js';
```

```bash
git add -A
git commit -m "feat(tools): ToolRegistry（Zod schema + 安全调用）"
```

---

## Task 8：内置工具 read_file / write_file

**Files:**
- Create: `packages/tools/src/builtin/read-file.ts`, `packages/tools/src/builtin/write-file.ts`, `packages/tools/src/builtin/files.test.ts`

- [ ] **Step 1: 写失败测试**

`packages/tools/src/builtin/files.test.ts`:
```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { createLogger } from '@hermes/core';

let dir: string;
const ctx = () => ({ cwd: dir, logger: createLogger('test') });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hermes-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('write_file 写入并 read_file 带行号读回', async () => {
  await writeFileTool.handler({ path: 'a.txt', content: 'l1\nl2' }, ctx());
  const out = await readFileTool.handler({ path: 'a.txt' }, ctx());
  expect(out).toContain('1');
  expect(out).toContain('l1');
  expect(out).toContain('l2');
});

test('write_file 自动建父目录', async () => {
  await writeFileTool.handler({ path: 'sub/dir/b.txt', content: 'x' }, ctx());
  expect(readFileSync(join(dir, 'sub/dir/b.txt'), 'utf8')).toBe('x');
});

test('read_file 不存在的文件由 handler 抛错（注册后由 registry 捕获）', async () => {
  await expect(readFileTool.handler({ path: 'nope.txt' }, ctx())).rejects.toThrow();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/tools/src/builtin/files.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现两个工具**

`packages/tools/src/builtin/read-file.ts`:
```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ToolDef } from '../registry.js';

const MAX_BYTES = 100 * 1024;

export const readFileTool: ToolDef = {
  name: 'read_file',
  description: '读取文本文件内容，返回带行号的文本。超过 100KB 会截断。',
  toolset: 'core',
  schema: z.object({ path: z.string().describe('相对或绝对文件路径') }),
  handler: async ({ path }, ctx) => {
    const full = resolve(ctx.cwd, path);
    let text = readFileSync(full, 'utf8');
    let truncated = false;
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
      text = text.slice(0, MAX_BYTES);
      truncated = true;
    }
    const numbered = text.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
    return truncated ? `${numbered}\n... [已截断，超过 100KB]` : numbered;
  },
};
```

`packages/tools/src/builtin/write-file.ts`:
```ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import type { ToolDef } from '../registry.js';

export const writeFileTool: ToolDef = {
  name: 'write_file',
  description: '写入（覆盖）文本文件，自动创建父目录。返回写入字节数。',
  toolset: 'core',
  schema: z.object({ path: z.string(), content: z.string() }),
  handler: async ({ path, content }, ctx) => {
    const full = resolve(ctx.cwd, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
    return `已写入 ${Buffer.byteLength(content, 'utf8')} 字节到 ${path}`;
  },
};
```

- [ ] **Step 4: 运行确认通过 + 提交**

Run: `pnpm vitest run packages/tools/src/builtin/files.test.ts`
Expected: PASS

```bash
git add -A
git commit -m "feat(tools): read_file 与 write_file 内置工具"
```

---

## Task 9：内置工具 terminal（local 后端）

**Files:**
- Create: `packages/tools/src/builtin/terminal.ts`, `packages/tools/src/builtin/terminal.test.ts`

> 前置条件：测试与运行依赖 `bash`、`sleep`、`exit` 在 PATH 中。本机为 Windows，使用 git-bash（与当前开发环境一致）。若 spawn 报 ENOENT，先确认 git-bash 的 `bash` 在 PATH。

- [ ] **Step 1: 写失败测试**

`packages/tools/src/builtin/terminal.test.ts`:
```ts
import { test, expect } from 'vitest';
import { terminalTool } from './terminal.js';
import { createLogger } from '@hermes/core';

const ctx = { cwd: process.cwd(), logger: createLogger('test') };

test('terminal 执行命令并返回 stdout 与 exitCode', async () => {
  const out = await terminalTool.handler({ command: 'echo hermes' }, ctx);
  expect(out).toContain('hermes');
  expect(out).toContain('exit code: 0');
});

test('terminal 非零退出码也返回（不抛）', async () => {
  const out = await terminalTool.handler({ command: 'exit 3' }, ctx);
  expect(out).toContain('exit code: 3');
});

test('terminal 超时被终止', async () => {
  const out = await terminalTool.handler({ command: 'sleep 5', timeout: 500 }, ctx);
  expect(out.toLowerCase()).toContain('timeout');
}, 10000);
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/tools/src/builtin/terminal.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 terminal**

`packages/tools/src/builtin/terminal.ts`:
```ts
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ToolDef } from '../registry.js';

export const terminalTool: ToolDef = {
  name: 'terminal',
  description: '在 local shell（bash）执行命令，返回 stdout/stderr 与退出码。',
  toolset: 'core',
  schema: z.object({
    command: z.string().describe('要执行的 shell 命令'),
    timeout: z.number().optional().describe('超时毫秒数，默认 120000'),
  }),
  handler: ({ command, timeout = 120_000 }, ctx) =>
    new Promise<string>((resolve) => {
      const child = spawn('bash', ['-c', command], { cwd: ctx.cwd });
      let stdout = '', stderr = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
      const onAbort = () => child.kill('SIGKILL');
      ctx.signal?.addEventListener('abort', onAbort);

      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        if (timedOut) return resolve(`[timeout] 命令超过 ${timeout}ms 被终止\nstdout:\n${stdout}\nstderr:\n${stderr}`);
        const parts = [];
        if (stdout) parts.push(`stdout:\n${stdout}`);
        if (stderr) parts.push(`stderr:\n${stderr}`);
        parts.push(`exit code: ${code ?? -1}`);
        resolve(parts.join('\n'));
      });
    }),
};
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/tools/src/builtin/terminal.test.ts`
Expected: PASS（3 个）

- [ ] **Step 5: 写 builtin/index 汇总注册 + 提交**

`packages/tools/src/builtin/index.ts`:
```ts
import type { ToolRegistry } from '../registry.js';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { terminalTool } from './terminal.js';

export const builtinTools = [readFileTool, writeFileTool, terminalTool];

export function registerBuiltins(registry: ToolRegistry): void {
  for (const t of builtinTools) registry.register(t);
}
```

在 `packages/tools/src/index.ts` 追加 `export * from './builtin/index.js';`

```bash
git add -A
git commit -m "feat(tools): terminal 工具与内置工具注册"
```

---

## Task 10：@hermes/agent — events + system prompt

**Files:**
- Create: `packages/agent/package.json`, `packages/agent/tsconfig.json`, `packages/agent/src/events.ts`, `packages/agent/src/system-prompt.ts`, `packages/agent/src/index.ts`

- [ ] **Step 1: 创建包配置**

`packages/agent/package.json`:
```json
{
  "name": "@hermes/agent",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
  "scripts": { "build": "tsup src/index.ts --format esm --dts --clean" },
  "dependencies": {
    "@hermes/core": "workspace:*",
    "@hermes/providers": "workspace:*",
    "@hermes/tools": "workspace:*"
  }
}
```
`packages/agent/tsconfig.json`: extends base。

- [ ] **Step 2: 写 events 与 system-prompt**

`packages/agent/src/events.ts`:
```ts
import type { CompletionResult } from '@hermes/providers';

export type LoopEvent =
  | { type: 'assistant_delta'; text: string }
  | { type: 'tool_call'; name: string; args: string }
  | { type: 'tool_result'; name: string; output: string }
  | { type: 'turn_done'; result: CompletionResult }
  | { type: 'error'; error: string };
```

`packages/agent/src/system-prompt.ts`:
```ts
export function buildSystemPrompt(cwd: string): string {
  // TODO(阶段3/4): 注入记忆 / 技能 / 人格
  return [
    '你是 Hermes，一个能够调用工具完成任务的 AI 代理。',
    `当前时间：${new Date().toISOString()}`,
    `当前工作目录：${cwd}`,
    '可用工具会以工具定义的形式提供。需要时调用它们，完成后用自然语言回答用户。',
  ].join('\n');
}
```

- [ ] **Step 3: index 导出 + typecheck + 提交**

`packages/agent/src/index.ts`（此时 conversation-loop 尚不存在，该行先保持注释，Task 11 完成后放开）：
```ts
export * from './events.js';
export * from './system-prompt.js';
// export * from './conversation-loop.js';  // Task 11 完成后放开
```

Run: `pnpm install && pnpm --filter @hermes/agent exec tsc --noEmit`
Expected: 无错误

```bash
git add -A
git commit -m "feat(agent): LoopEvent 与 system prompt"
```

---

## Task 11：ConversationLoop（核心循环，TDD）

**Files:**
- Create: `packages/agent/src/conversation-loop.ts`, `packages/agent/src/conversation-loop.test.ts`
- Modify: `packages/agent/src/index.ts`

- [ ] **Step 1: 写失败测试（用 mock provider 编排两轮）**

`packages/agent/src/conversation-loop.test.ts`:
```ts
import { test, expect } from 'vitest';
import { SessionDB, createLogger } from '@hermes/core';
import { ToolRegistry } from '@hermes/tools';
import { z } from 'zod';
import type { Provider, CompletionChunk, CompletionResult } from '@hermes/providers';
import { runConversation } from './conversation-loop.js';
import type { LoopEvent } from './events.js';

// mock provider：第一轮发 tool_call，第二轮发纯文本
function scriptedProvider(scripts: CompletionChunk[][]): Provider {
  let turn = 0;
  return {
    name: 'mock',
    async *complete() { for (const c of scripts[turn] ?? []) yield c; turn++; },
    async aggregate(chunks): Promise<CompletionResult> {
      let content = ''; const calls = new Map<number, any>();
      for await (const c of chunks) {
        if (c.contentDelta) content += c.contentDelta;
        if (c.toolCallDelta) {
          const d = c.toolCallDelta; const cur = calls.get(d.index) ?? { id: '', name: '', arguments: '' };
          if (d.id) cur.id = d.id; if (d.name) cur.name = d.name; if (d.argsDelta) cur.arguments += d.argsDelta;
          calls.set(d.index, cur);
        }
      }
      const toolCalls = [...calls.values()];
      return { content: content || null, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop' };
    },
  };
}

function makeDeps(provider: Provider) {
  const db = new SessionDB(':memory:');
  const registry = new ToolRegistry();
  registry.register({
    name: 'read_file', description: 'read', toolset: 'core',
    schema: z.object({ path: z.string() }),
    handler: async (a) => `内容 of ${a.path}`,
  });
  return { db, registry, deps: { db, provider, registry, model: 'mock', maxIterations: 10 } };
}

test('单轮纯文本：无工具调用直接结束', async () => {
  const provider = scriptedProvider([[{ contentDelta: '你好' }]]);
  const { db, deps } = makeDeps(provider);
  const s = db.createSession();
  const events: LoopEvent[] = [];
  for await (const e of runConversation(deps, s.id, 'hi', { cwd: '/', logger: createLogger('t') })) events.push(e);

  expect(events.some((e) => e.type === 'assistant_delta')).toBe(true);
  expect(events.at(-1)?.type).toBe('turn_done');
  // 落库：user + assistant = 2 条
  expect(db.getMessages(s.id).length).toBe(2);
});

test('工具调用轮：执行工具后再产出最终回答', async () => {
  const provider = scriptedProvider([
    [{ toolCallDelta: { index: 0, id: 'c1', name: 'read_file', argsDelta: '{"path":"a"}' } }],
    [{ contentDelta: '文件读完了' }],
  ]);
  const { db, deps } = makeDeps(provider);
  const s = db.createSession();
  const events: LoopEvent[] = [];
  for await (const e of runConversation(deps, s.id, '读 a', { cwd: '/', logger: createLogger('t') })) events.push(e);

  expect(events.some((e) => e.type === 'tool_call' && e.name === 'read_file')).toBe(true);
  expect(events.some((e) => e.type === 'tool_result')).toBe(true);
  expect(events.at(-1)?.type).toBe('turn_done');
  // user + assistant(toolcall) + tool + assistant(final) = 4 条
  expect(db.getMessages(s.id).length).toBe(4);
});

test('超过 maxIterations 产出 error', async () => {
  // 每轮都发 tool_call，永不停
  const loopChunk: CompletionChunk[] = [{ toolCallDelta: { index: 0, id: 'c1', name: 'read_file', argsDelta: '{"path":"a"}' } }];
  const provider: Provider = {
    name: 'mock', async *complete() { for (const c of loopChunk) yield c; },
    async aggregate() { return { content: null, toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }], finishReason: 'tool_calls' }; },
  };
  const { db, deps } = makeDeps(provider);
  deps.maxIterations = 2;
  const s = db.createSession();
  const events: LoopEvent[] = [];
  for await (const e of runConversation(deps, s.id, 'x', { cwd: '/', logger: createLogger('t') })) events.push(e);
  expect(events.at(-1)?.type).toBe('error');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/agent/src/conversation-loop.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 runConversation**

`packages/agent/src/conversation-loop.ts`:
```ts
import { v4 as uuid } from 'uuid';
import type { SessionDB, Message } from '@hermes/core';
import type { Provider, CompletionChunk } from '@hermes/providers';
import type { ToolRegistry, ToolContext } from '@hermes/tools';
import type { LoopEvent } from './events.js';
import { buildSystemPrompt } from './system-prompt.js';

export interface LoopDeps {
  db: SessionDB;
  provider: Provider;
  registry: ToolRegistry;
  model: string;
  maxIterations: number;
}

export async function* runConversation(
  deps: LoopDeps,
  sessionId: string,
  userText: string,
  ctx: ToolContext,
): AsyncIterable<LoopEvent> {
  const { db, provider, registry, model, maxIterations } = deps;

  // 1. 构建消息：system + 历史 + 新 user
  const history = db.getMessages(sessionId);
  const messages: Message[] = [
    { role: 'system', content: buildSystemPrompt(ctx.cwd) },
    ...history,
    { role: 'user', content: userText },
  ];
  db.appendMessage(sessionId, { role: 'user', content: userText });

  const tools = registry.getSchemas();

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // a. 流式调模型：边收边发 assistant_delta，同时缓存 chunk 供聚合
      const captured: CompletionChunk[] = [];
      for await (const chunk of provider.complete({ model, messages, tools, signal: ctx.signal })) {
        captured.push(chunk);
        if (chunk.contentDelta) yield { type: 'assistant_delta', text: chunk.contentDelta };
      }
      // b. 聚合成完整结果（stream 只消费一次，这里回放缓存的 chunk）
      const result = await provider.aggregate((async function* () { for (const c of captured) yield c; })());

      // c. 落库 assistant 消息
      const assistantMsg: Message = {
        role: 'assistant',
        content: result.content,
        toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
      };
      messages.push(assistantMsg);
      db.appendMessage(sessionId, assistantMsg);

      // d. 无工具调用 → 结束
      if (result.toolCalls.length === 0) {
        yield { type: 'turn_done', result };
        return;
      }

      // e. 执行每个工具调用
      for (const call of result.toolCalls) {
        yield { type: 'tool_call', name: call.name, args: call.arguments };
        const output = await registry.call(call.name, call.arguments, ctx);
        yield { type: 'tool_result', name: call.name, output };
        const toolMsg: Message = {
          role: 'tool', content: output,
          toolCallId: call.id || uuid(), name: call.name,
        };
        messages.push(toolMsg);
        db.appendMessage(sessionId, toolMsg);
      }
    }
    yield { type: 'error', error: `达到最大工具迭代次数（${maxIterations}），已停止。` };
  } catch (e) {
    yield { type: 'error', error: (e as Error).message };
  }
}
```

> 说明：退出判据用 `result.toolCalls.length === 0`（不依赖 finishReason），符合 spec §8.3。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/agent/src/conversation-loop.test.ts`
Expected: PASS（3 个）

- [ ] **Step 5: 放开 index 导出 + 全包测试 + 提交**

放开 `packages/agent/src/index.ts` 中 `export * from './conversation-loop.js';`

Run: `pnpm vitest run` （全仓库）
Expected: 全部 PASS

```bash
git add -A
git commit -m "feat(agent): ConversationLoop 核心循环"
```

---

## Task 12：@hermes/cli — 装配与 REPL

**Files:**
- Create: `apps/cli/package.json`, `apps/cli/tsconfig.json`, `apps/cli/src/main.ts`, `apps/cli/src/repl.ts`

- [ ] **Step 1: 创建包配置**

`apps/cli/package.json`:
```json
{
  "name": "@hermes/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": { "hermes-ts": "./dist/main.js" },
  "scripts": {
    "dev": "tsx src/main.ts",
    "build": "tsup src/main.ts --format esm --clean"
  },
  "dependencies": {
    "@hermes/core": "workspace:*",
    "@hermes/providers": "workspace:*",
    "@hermes/tools": "workspace:*",
    "@hermes/agent": "workspace:*",
    "dotenv": "^16.4.0",
    "picocolors": "^1.0.0"
  }
}
```
`apps/cli/tsconfig.json`: extends base。

- [ ] **Step 2: 实现 repl**

`apps/cli/src/repl.ts`:
```ts
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import pc from 'picocolors';
import type { SessionDB } from '@hermes/core';
import { runConversation, type LoopDeps } from '@hermes/agent';
import type { ToolContext } from '@hermes/tools';

export async function repl(deps: LoopDeps, db: SessionDB, ctx: Omit<ToolContext, 'signal'>) {
  let session = db.createSession({ source: 'cli', modelConfig: { provider: deps.provider.name, model: deps.model } });
  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log(pc.bold(`Hermes TS · 模型 ${deps.model} · 会话 ${session.id.slice(0, 8)}`));
  console.log(pc.dim('输入对话内容；/new 新会话，/help 帮助，/exit 退出。'));

  for (;;) {
    const line = (await rl.question(pc.cyan('\n› '))).trim();
    if (!line) continue;
    if (line === '/exit') break;
    if (line === '/help') { console.log('/new 新会话  /exit 退出  /help 帮助'); continue; }
    if (line === '/new') {
      db.endSession(session.id);
      session = db.createSession({ source: 'cli', modelConfig: { provider: deps.provider.name, model: deps.model } });
      console.log(pc.dim(`新会话 ${session.id.slice(0, 8)}`));
      continue;
    }

    const controller = new AbortController();
    let interrupts = 0;
    const onSig = () => {
      if (++interrupts >= 2) { console.log('\n中断退出'); process.exit(0); }
      controller.abort();
      console.log(pc.yellow('\n[已中断当前轮，再次 Ctrl+C 退出]'));
    };
    process.on('SIGINT', onSig);

    try {
      for await (const ev of runConversation(deps, session.id, line, { ...ctx, signal: controller.signal })) {
        switch (ev.type) {
          case 'assistant_delta': stdout.write(ev.text); break;
          case 'tool_call': console.log(pc.dim(`\n⚙ ${ev.name}(${ev.args})`)); break;
          case 'tool_result': console.log(pc.dim(`↳ ${truncate(ev.output, 500)}`)); break;
          case 'turn_done': {
            const u = ev.result.usage;
            stdout.write('\n');
            if (u) console.log(pc.dim(`[tokens ${u.promptTokens}+${u.completionTokens}]`));
            break;
          }
          case 'error': console.log(pc.red(`\n错误：${ev.error}`)); break;
        }
      }
    } finally {
      process.off('SIGINT', onSig);
    }
  }

  db.endSession(session.id);
  rl.close();
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…[截断]` : s;
}
```

`apps/cli/src/main.ts`:
```ts
#!/usr/bin/env node
import 'dotenv/config';
import { loadConfig, ensureHermesHome, sessionDbPath, SessionDB, createLogger } from '@hermes/core';
import { createProvider } from '@hermes/providers';
import { ToolRegistry, registerBuiltins } from '@hermes/tools';
import { repl } from './repl.js';

async function main() {
  const config = loadConfig();
  if (!config.apiKey) {
    console.error('缺少 API Key。请设置环境变量 GLM_API_KEY 或在 ~/.hermes/config.yaml 配置。');
    process.exit(1);
  }
  ensureHermesHome();
  const db = new SessionDB(sessionDbPath());
  const provider = createProvider(config);
  const registry = new ToolRegistry();
  registerBuiltins(registry);

  const deps = { db, provider, registry, model: config.model, maxIterations: config.maxIterations };
  await repl(deps, db, { cwd: process.cwd(), logger: createLogger('cli') });
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: 安装 + typecheck**

Run: `pnpm install && pnpm --filter @hermes/cli exec tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "feat(cli): 装配依赖与 readline REPL"
```

---

## Task 13：端到端验证 + 文档

**Files:**
- Create: `README.md`
- Modify: 无

- [ ] **Step 1: 全仓库类型检查与测试**

Run: `pnpm -r exec tsc --noEmit && pnpm vitest run`
Expected: 类型无错 + 全部测试 PASS

- [ ] **Step 2: 手动连 GLM 联调**

准备 `.env`（从 `.env.example` 复制并填入真实 `GLM_API_KEY`）。

Run: `pnpm cli`
手动验证脚本：
1. 输入「在当前目录创建 hello.txt，内容是 hi，然后读出来给我看」
   - 预期：看到 `⚙ write_file(...)`、`⚙ read_file(...)` 工具调用，最终模型用自然语言确认。
2. 输入「列出当前目录的文件」
   - 预期：看到 `⚙ terminal(...)` 执行 `ls`，返回文件列表。
3. `/new` 后确认会话切换；`/exit` 退出。
4. 重启 `pnpm cli`，确认无报错（历史已落库到 `~/.hermes/sessions.db`）。

- [ ] **Step 3: 写 README**

`README.md`（简要：项目简介、阶段1范围、安装 `pnpm install`、配置 `.env`、运行 `pnpm cli`、测试 `pnpm test`、阶段路线图链接到 spec）。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "docs: 阶段1 README 与端到端验证"
```

---

## 完成定义（阶段 1 DoD）

- [ ] `pnpm vitest run` 全绿（core/providers/tools/agent 单测）
- [ ] `pnpm -r exec tsc --noEmit` 无类型错误
- [ ] 手动连 GLM 能完成一次带工具调用的真实对话（写文件 + 读文件 + 执行命令）
- [ ] `/new` 切换会话正常；重启后 `~/.hermes/sessions.db` 保留历史
- [ ] 所有任务已提交到 git
