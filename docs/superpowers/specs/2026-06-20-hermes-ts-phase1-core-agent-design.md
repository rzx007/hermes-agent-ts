# Hermes Agent TS — 阶段 1：核心代理（Core Agent MVP）设计

- **日期**: 2026-06-20
- **状态**: 已批准（设计阶段）
- **作者**: Hermes TS 复刻项目
- **源项目**: `D:/code/personal-project/hermes-agent`（Nous Research Hermes Agent, Python, ~270K LOC / 2418 文件）

---

## 1. 背景与目标

### 1.1 总体目标
用 TypeScript **完整复刻** Python 版 hermes-agent。由于源项目体量巨大（~270K 行 Python、14 个独立子系统），采用**分阶段、逐子项目**的方式推进，每个子项目独立走「设计 → 计划 → 实现」循环。

### 1.2 保真度选择
**架构级对齐 + 惯用 TS 重写**：保留与 Python 版相同的模块边界、概念和工作流（相同的命令、相同的能力），但内部使用 TS 地道写法（async/await、Zod、better-sqlite3）。数据格式允许优化，**不强求与 Python 版二进制/磁盘格式兼容**。

### 1.3 阶段路线图（确定的构建顺序）
```
阶段 0  地基层      constants / logging / config / utils / paths(~/.hermes)
阶段 1  ★核心代理   SessionDB + Providers + Tool Registry + Conversation Loop  ← 本文档
阶段 2  工具系统    Toolsets 分组 + 核心工具 + Terminal Backends(docker/ssh/...)
阶段 3  记忆+技能    MemoryManager + USER.md/MEMORY.md + Skills 加载/自改进
阶段 4  用户界面    CLI REPL 增强 + 斜杠命令 + 完整 TUI（复用 ui-tui）
阶段 5  集成层      MCP / Cron / 委派子代理
阶段 6  网关        Gateway 主循环 + 平台适配器（Telegram 优先）
阶段 7  外围        ACP / Web 仪表板 / 批量轨迹 / 压缩器
```

### 1.4 本阶段（阶段 1）目标
做出一个**能用的最小代理**：能对话、能调用工具、能多轮循环、能持久化会话。这是后续所有阶段的地基，也是最大风险点，因此优先攻克。

---

## 2. 范围（Scope）

### 2.1 MVP 包含
- `SessionDB`：SQLite 建表（sessions / messages），保存与读取会话历史
- `Provider` 抽象 + 一个 OpenAI 兼容客户端（指向 GLM/智谱 Coding Plan）
- `ToolRegistry`：工具自注册 + Zod schema → JSON Schema
- `ConversationLoop`：构建消息 → 调模型 → 解析 tool_calls → 执行工具 → 回灌结果 → 循环直到无工具调用 → 落库
- **3 个基础工具**：`read_file`、`write_file`、`terminal`（local 后端，bash 执行）
- **极简 CLI**：readline 交互（`hermes-ts` 启动，`/new` `/exit` `/help`）
- 流式输出（基础版，模型增量打到终端）

### 2.2 明确不做（留给后续阶段）
重试/多模型降级、上下文压缩、记忆系统、技能系统、MCP、cron、网关、多终端后端、完整 TUI、命令审批/权限白名单、FTS5 会话搜索、会话压缩链/分支。

### 2.3 联调环境
- 模型提供商：**GLM/智谱 Coding Plan**（OpenAI 兼容端点）
- Provider 抽象先实现 OpenAI 兼容客户端指向 GLM，默认模型从 config 读取（如 `glm-4.6`）

---

## 3. 技术栈

| 维度 | 选择 |
|------|------|
| 运行时 | Node.js 20+ |
| 语言 | TypeScript（strict） |
| 包管理 | pnpm（workspace monorepo） |
| 开发运行 | tsx |
| 打包 | tsup |
| SQLite | better-sqlite3（同步 API） |
| 校验/Schema | Zod（+ zod-to-json-schema） |
| 测试 | Vitest |
| 日志 | pino |
| 模型 SDK | openai（官方 SDK，OpenAI 兼容客户端） |

---

## 4. 项目结构

### 4.1 目录骨架（pnpm workspace 多包 monorepo）
```
hermes-agent-ts/
├── pnpm-workspace.yaml
├── package.json              # 根：脚本、devDeps(tsx/tsup/vitest/typescript)
├── tsconfig.base.json        # 共享 strict 配置
├── .env.example              # GLM_API_KEY / GLM_BASE_URL / 默认模型
├── packages/
│   ├── core/                 # @hermes/core
│   │   └── src/{types,config,paths,logging,session-db,index}.ts (+ *.test.ts)
│   ├── providers/            # @hermes/providers  (依赖 core)
│   │   └── src/{provider,openai-compatible,glm,index}.ts
│   ├── tools/                # @hermes/tools  (依赖 core)
│   │   └── src/{registry, builtin/{read-file,write-file,terminal}, index}.ts
│   └── agent/                # @hermes/agent  (依赖 core, providers, tools)
│       └── src/{conversation-loop, system-prompt, index}.ts
└── apps/
    └── cli/                  # @hermes/cli  (依赖 agent, core), bin: hermes-ts
        └── src/{main,repl}.ts
```

### 4.2 依赖图（单向无环）
```
core ← providers ← agent ← cli
  ↖──── tools ────↗
```
`core` 不依赖任何内部包；`agent` 是装配点；`cli` 是入口。后续阶段扩展方式：工具加到 `tools/builtin/`；gateway/tui/web 作为新 `apps/*`；记忆/技能作为新 `packages/*`。无需回头重构。

---

## 5. 核心数据模型

### 5.1 核心类型（`core/types.ts`，对齐 OpenAI message 格式）
```ts
type Role = 'system' | 'user' | 'assistant' | 'tool';

interface ToolCall {
  id: string;
  name: string;
  arguments: string;        // 原始 JSON 字符串（与 OpenAI 一致）
}

interface Message {
  role: Role;
  content: string | null;
  toolCalls?: ToolCall[];   // role=assistant 时
  toolCallId?: string;      // role=tool 时，对应某次调用
  name?: string;            // 工具名（role=tool）
}

interface Session {
  id: string;               // uuid
  userId: string;           // MVP 固定 'local'
  title: string | null;
  source: string;           // 'cli'
  startedAt: number; endedAt: number | null;
  parentSessionId: string | null;        // 预留压缩链/分支，MVP 恒为 null
  modelConfig: Record<string, unknown>;  // JSON，存 provider/model 等
}
```

### 5.2 SQLite 表结构（`session-db.ts`，WAL 模式）
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  source TEXT NOT NULL DEFAULT 'cli',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  parent_session_id TEXT,
  model_config TEXT NOT NULL DEFAULT '{}'   -- JSON
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,           -- 会话内顺序
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,                -- JSON，可空
  tool_call_id TEXT,
  name TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_session ON messages(session_id, seq);
```
> 阶段 3 再加 `sessions_fts`（FTS5）。MVP 表结构已为其预留空间。

### 5.3 SessionDB 公开 API（同步）
```ts
// createSession 入参
interface CreateSessionOpts {
  userId?: string;          // 默认 'local'
  title?: string | null;
  source?: string;          // 默认 'cli'
  modelConfig?: Record<string, unknown>;
}

class SessionDB {
  createSession(opts?: CreateSessionOpts): Session
  getSession(id): Session | null
  endSession(id, reason?): void
  appendMessage(sessionId, msg: Message): void   // 自动算 seq
  getMessages(sessionId): Message[]
  listSessions(limit?): Session[]
  close(): void
}
```

---

## 6. Provider 抽象

### 6.1 接口（`providers/provider.ts`）
```ts
interface ToolSchema {            // 传给模型的工具定义（OpenAI function 格式）
  name: string;
  description: string;
  parameters: object;             // JSON Schema（由 Zod 转出）
}

interface CompletionRequest {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  stream?: boolean;
  signal?: AbortSignal;           // 支持 Ctrl+C 中断
}

interface CompletionChunk {       // 流式增量
  contentDelta?: string;
  toolCallDelta?: { index: number; id?: string; name?: string; argsDelta?: string };
}

interface CompletionResult {      // 聚合后的完整结果
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | string;
  usage?: { promptTokens: number; completionTokens: number };
}

interface Provider {
  readonly name: string;
  complete(req: CompletionRequest): AsyncIterable<CompletionChunk>;  // 始终流式
  aggregate(chunks): Promise<CompletionResult>;  // 把流聚合成完整结果
}
```

### 6.2 实现
- `openai-compatible.ts`：通用 OpenAI 兼容客户端，用官方 `openai` SDK，`baseURL` 可配。负责内部 `Message` ↔ OpenAI 格式互转，处理 SSE 流式增量，**按 `index` 累积分片的 tool_calls**（id/name/arguments）。
- `glm.ts`：薄封装，`new OpenAICompatibleProvider({ baseURL: GLM_BASE_URL, apiKey: GLM_API_KEY, name: 'glm' })`。
- 工厂：`createProvider(config)` 按 `provider` 字段返回实例。MVP 只注册 glm。

### 6.3 设计要点
**始终走流式**（`complete` 返回 AsyncIterable），非流式需求由 `aggregate` 收口。CLI 边出边打字、loop 拿完整结果，二者复用同一路径。

---

## 7. ToolRegistry + 内置工具

### 7.1 注册机制（`tools/registry.ts`）
```ts
interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  logger: Logger;
}

interface ToolDef<T extends z.ZodTypeAny> {
  name: string;
  description: string;
  toolset: string;                       // MVP 都归 'core'，阶段 2 启用分组
  schema: T;
  handler: (args: z.infer<T>, ctx: ToolContext) => Promise<string>;  // 返回给模型的文本
}

class ToolRegistry {
  register<T>(def: ToolDef<T>): void
  getSchemas(names?: string[]): ToolSchema[]   // Zod→JSON Schema (zod-to-json-schema)
  has(name): boolean
  call(name, rawArgs: string, ctx): Promise<string>  // JSON.parse → Zod 校验 → handler；失败返回结构化错误文本
}
```

### 7.2 内置工具（3 个）
| 工具 | 入参 | 行为 | 安全 |
|------|------|------|------|
| `read_file` | `{ path }` | 读文件，带行号返回；超过上限截断（默认 100KB，可配） | 路径解析基于 cwd |
| `write_file` | `{ path, content }` | 写/覆盖文件，返回写入字节数 | 自动建父目录 |
| `terminal` | `{ command, timeout? }` | local 后端：`child_process` 执行 bash，捕获 stdout/stderr/exitCode，支持 timeout 与 `signal` 中断 | **MVP 简化：默认直接执行**（审批/白名单留后续阶段，见 §10 已知风险） |

> `terminal` MVP 只做 `local` 后端；阶段 2 抽象成 `Backend` 接口。Windows 下走 git-bash（与当前开发环境一致）。

---

## 8. ConversationLoop（核心）

### 8.1 入口（`agent/conversation-loop.ts`）
```ts
interface LoopDeps {
  db: SessionDB;
  provider: Provider;
  registry: ToolRegistry;
  model: string;
  maxIterations: number;        // 防工具调用死循环，默认 ~25
}

async function* runConversation(
  deps: LoopDeps,
  sessionId: string,
  userText: string,
  ctx: ToolContext,
): AsyncIterable<LoopEvent>     // 产出事件流供 CLI 渲染
```

### 8.2 事件流（`LoopEvent`，CLI 与 loop 解耦）
```
{ type: 'assistant_delta', text }       // 流式正文增量
{ type: 'tool_call', name, args }       // 即将执行某工具
{ type: 'tool_result', name, output }   // 工具返回
{ type: 'turn_done', result }           // 本轮结束（含 usage）
{ type: 'error', error }
```

### 8.3 循环逻辑
```
1. 读 session 历史 → messages（首条为 system prompt）
2. 追加 user 消息，落库
3. loop (iteration < maxIterations):
     a. provider.complete(messages, tools) → 流式
     b. 边收边 emit assistant_delta；同时聚合 → CompletionResult
     c. 落库 assistant 消息（含 toolCalls）
     d. 若【聚合结果中没有解析出 toolCalls】→ emit turn_done，break
        （以「是否有 toolCalls」为主判据，finishReason 仅作辅助参考——
         GLM 等 OpenAI 兼容端点在带 tool_calls 时也可能返回 finish_reason='stop'，
         不能单靠 finishReason 判断，否则会误退出或卡住）
     e. 对每个 toolCall：
          emit tool_call → registry.call() → emit tool_result
          落库 tool 消息（role='tool', toolCallId）
          把 tool 结果 append 到 messages
     f. iteration++
4. 达到 maxIterations：emit error('达到最大工具迭代次数')
```

### 8.4 System Prompt（`agent/system-prompt.ts`）
MVP 极简：身份声明、当前时间、cwd。可用工具由模型从 tool schema 感知。记忆/技能/人格注入点留 TODO 注释，阶段 3/4 填充。

---

## 9. CLI 交互

### 9.1 入口（`apps/cli`，bin: `hermes-ts`）
```
1. 加载 config（~/.hermes/config.yaml + .env 回退）
2. 打开 SessionDB（~/.hermes/sessions.db）
3. createProvider(config) → glm
4. registry = new ToolRegistry(); 注册 3 个内置工具
5. 进入 repl()
```

### 9.2 REPL 行为（`repl.ts`，node 内置 readline）
```
- 启动即 createSession(source='cli')，打印欢迎行（模型名、会话 id 短码）
- 循环读取用户输入：
    /new    → endSession 旧的，createSession 新的
    /exit   → endSession，关库，退出
    /help   → 列出命令
    其它    → 调 runConversation，消费事件流：
               assistant_delta → process.stdout.write（流式打字）
               tool_call       → 灰色打印 "⚙ 调用 read_file({...})"
               tool_result     → 折叠/截断打印工具输出
               turn_done       → 换行 + 可选 usage 行
- Ctrl+C：第一次中断当前轮（abort signal），第二次退出；
  计数在每轮结束后重置（即「双击退出」仅在同一轮内连续按下时生效）
```

### 9.3 设计要点
CLI **只消费 LoopEvent**，不碰 DB/provider 细节。阶段 4 换完整 TUI 时 loop 零改动。

---

## 10. 错误处理

| 来源 | 策略 |
|------|------|
| **Provider/网络错误** | `complete` 抛错 → loop emit `error` → CLI 友好提示（401→检查 GLM_API_KEY；429→限流；网络→重试）。当前轮中止，会话保留 |
| **工具入参 JSON 解析/Zod 校验失败** | `registry.call` 捕获，**不抛给 loop**，错误格式化成文本作为 tool_result 回灌模型（自我纠正） |
| **工具执行异常**（文件不存在、命令超时） | 同上，捕获 → 结构化错误文本回灌 |
| **maxIterations 超限** | emit error，提示"工具调用过多，已停止" |
| **Ctrl+C 中断** | AbortSignal 传到 provider 流与 terminal 子进程；干净中止当前轮，落已完成消息 |
| **DB 写入失败** | 致命，打印错误并安全退出 |

**原则**：模型能自我纠正的错（工具层）→ 回灌；纠正不了的错（网络/配置/DB）→ 上抛用户。

### 10.1 已知风险（MVP 接受，后续阶段消除）
- `terminal` 工具无审批/白名单，模型可执行任意命令 → 阶段 2/安全阶段引入命令审批。
- 无 token 上限/上下文压缩，长会话可能超模型上下文 → 阶段 3 引入压缩。

---

## 11. 测试策略（Vitest，就近 `*.test.ts`）

| 层 | 测什么 | 怎么测 |
|----|--------|--------|
| `core/session-db` | 建会话、追加消息、seq 自增、读回顺序、end | 内存 SQLite（`:memory:`） |
| `providers/openai-compatible` | Message↔OpenAI 互转、**流式 tool_call 分片按 index 聚合**、SSE 解析 | mock SDK，构造 chunk 序列断言 |
| `tools/registry` | 注册、Zod→JSON Schema、校验失败返回错误文本、handler 调用 | 注册假工具 |
| `tools/builtin` | read/write 临时目录、terminal 跑 echo 验证 stdout/exitCode/超时 | 临时目录 + 真实子进程 |
| `agent/conversation-loop` | **核心**：mock provider 编排「先 tool_call → 再纯文本」两轮，断言事件序列、DB 落库条数、工具被调用 | mock Provider + 内存 DB + 假 registry |
| 手动联调 | 真连 GLM 跑通「读文件并总结」 | `pnpm --filter cli dev` |

### 11.1 完成定义（DoD）
- 上述单测全绿
- 手动连 GLM 能完成一次带工具调用的真实对话并落库
- `/new` 切换会话正常；重启后能列出历史会话

---

## 12. 后续阶段衔接点（设计中预留的扩展位）
- `Session.parentSessionId` / `modelConfig` → 压缩链、分支、委派（阶段 3/5）
- `messages` 表结构 → FTS5 全文搜索（阶段 3）
- `ToolDef.toolset` 字段 → Toolsets 分组（阶段 2）
- `terminal` 工具 → `Backend` 接口抽象 docker/ssh/...（阶段 2）
- `system-prompt.ts` 的记忆/技能/人格注入 TODO（阶段 3/4）
- CLI 的 LoopEvent 消费层 → 完整 TUI 复用 ui-tui（阶段 4）
- 新增 `apps/gateway`、`apps/web`、`packages/memory`、`packages/skills`（阶段 3-7）
