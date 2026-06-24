# Hermes Agent TS

用 TypeScript 复刻 [Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent)（原项目为 Python）。**架构级对齐 + 惯用 TS 重写**，分阶段推进。

## 当前状态：阶段 3b（会话全文搜索）✅

一个能跑通「对话 → 工具调用 → 多轮循环 → 会话持久化」的可用 AI 代理：具备工具集分组、一套本地文件/代码工具（读、写、精确编辑、搜索、列目录、执行命令）、危险命令审批、跨会话长期记忆,以及跨会话历史全文搜索。

- 阶段 1（核心代理 MVP）✅ — SessionDB / Provider / ToolRegistry / ConversationLoop / CLI
- 阶段 2（工具系统）✅ — Toolsets 分组 + `edit_file` / `search_files` / `list_dir`
- 阶段 2.5（命令审批）✅ — 危险命令审批 + hardline 永禁 + 白名单
- 阶段 3a（记忆系统）✅ — `MEMORY.md` / `USER.md` + `memory` 工具 + 系统提示注入
- 阶段 3b（会话全文搜索）✅ — SessionDB trigram FTS5 + `session_search` 工具 + `search` 工具集

- **@hermes/core** — 核心类型、`~/.hermes-ts` 路径、配置加载、pino 日志、SQLite 会话持久化（SessionDB）
- **@hermes/providers** — Provider 抽象 + OpenAI 兼容流式客户端（含流式 tool_call 分片聚合）+ GLM 工厂
- **@hermes/tools** — ToolRegistry（Zod schema → JSON Schema，安全调用）+ 工具集（Toolsets）分组（file / terminal / memory / search / core）+ 内置工具 `read_file` / `write_file` / `edit_file` / `search_files` / `list_dir` / `terminal` / `memory` / `session_search` + 命令审批（危险命令需确认）+ 记忆工具（memory）+ 会话全文搜索工具（session_search）
- **@hermes/agent** — ConversationLoop 核心循环（流式、工具循环、落库、中断、maxIterations 守卫）
- **@hermes/cli** — readline REPL（`/new` `/tools` `/exit` `/help`，流式渲染，Ctrl+C 中断）

## 技术栈

Node 20+ · TypeScript(strict) · pnpm workspace · tsx/tsup · better-sqlite3 · Zod · Vitest · pino · openai SDK

## 安装

```bash
pnpm install
```

> 注：`better-sqlite3` 需要原生模块。若安装时预编译二进制下载失败（ECONNRESET），见下方「故障排查」。

## 配置

复制 `.env.example` 为 `.env` 并填入 GLM/智谱 Coding Plan 的 API Key：

```bash
cp .env.example .env
# 编辑 .env：
# GLM_API_KEY=你的key
# GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
# HERMES_MODEL=glm-4.6
```

> `GLM_BASE_URL` 需与 Key 来源匹配（客户端走 OpenAI 兼容协议）：
> - 智谱开放平台（bigmodel.cn）→ `https://open.bigmodel.cn/api/paas/v4`
> - GLM Coding Plan（z.ai）→ `https://api.z.ai/api/coding/paas/v4`

也可用 `~/.hermes-ts/config.yaml`（env 优先）。

## 工具集配置 (Toolsets)

内置工具按「工具集」分组，可通过环境变量按需启用/禁用（逗号分隔，默认全部启用）：

```bash
# 禁用终端工具集（其余照常启用）
HERMES_DISABLED_TOOLSETS=terminal

# 仅启用文件工具集
HERMES_ENABLED_TOOLSETS=file
```

- `HERMES_ENABLED_TOOLSETS` — 留空（默认）= 启用全部已注册工具；指定后仅启用列出的工具集。
- `HERMES_DISABLED_TOOLSETS` — 在已启用集合中再剔除这些工具集。
- 可用工具集：`file`（read_file/write_file/edit_file/search_files/list_dir）、`terminal`（terminal）、`core`（= file + terminal），以及保留名 `all` / `*`（展开为全部）。
- 计算顺序：`enabled` 取并集 → 再减去 `disabled` → 末尾与实际注册的工具取交集。
- CLI 内输入 `/tools` 可查看当前会话实际启用的工具列表。

## 命令审批 (Command Approval)

`terminal` 工具在执行被判定为「危险」的命令前，会先经过审批闸门（ApprovalGuard）。

- **HARDLINE（永久阻止）**：`rm -rf /`、`mkfs`、`dd` 等极端破坏性命令永远不会被执行，**即使在 `off` 模式下也会被拦截**，且不可通过审批放行。
- **审批选项**：当命令危险且非 HARDLINE 时，会提示 `[o]nce / [s]ession / [a]lways / [d]eny`：
  - `once` — 仅本次允许；
  - `session` — 本次会话内对该命令免审批；
  - `always` — 永久允许，并持久化到 `~/.hermes-ts/allowlist.json`；
  - `deny` — 拒绝执行。
- **模式**（环境变量）：
  - `HERMES_APPROVAL_MODE=manual`（默认）— 仅危险命令才提示审批，安全命令直接放行；
  - `HERMES_APPROVAL_MODE=off` — 关闭审批提示（危险命令直接放行，但 HARDLINE 仍然拦截）；
  - `HERMES_YOLO_MODE=1` — 等同于 `off`（但 HARDLINE 仍然拦截）。

## 记忆 (Memory)

agent 具备跨会话的持久记忆，分两类文件，持久化在 `~/.hermes-ts/memories/`：

- `MEMORY.md`（agent 的长期笔记，上限 2200 字）— 模型主动记下的事实、约定、上下文。
- `USER.md`（用户画像，上限 1375 字）— 关于当前用户的偏好与信息。

机制：

- 每条记忆为一行，文件内以 `§` 分隔条目持久化。
- 模型通过 `memory` 工具主动维护记忆，支持 `add`（新增）/ `replace`（替换某条）/ `remove`（删除某条）三种操作。
- 每一轮对话开始时，两类记忆会被注入 system prompt，从而实现跨会话记忆。
- 字数超过上限时需先删除旧条目（remove）再写入新内容。

## 会话搜索 (Session Search)

agent 可对历史会话做跨会话全文搜索：

- `session_search` 工具基于 **SessionDB 上的 trigram FTS5**，支持中文子串匹配（查询需 ≥3 字符）。
- 仅索引 `user` / `assistant` 消息（触发器自动维护，建表时幂等回填历史数据）。
- 省略 `query` 时退化为浏览最近会话（返回会话预览）。
- 杜绝 FTS 语法注入：查询经 `sanitizeFtsQuery` 当作字面短语处理。
- 归入 `search` 工具集（并入 `core`）。

## 运行

```bash
pnpm cli          # 启动交互式 CLI（hermes-ts）
```

进入后直接输入对话；斜杠命令：`/new` 新会话、`/tools` 查看启用工具、`/exit` 退出、`/help` 帮助。会话历史持久化在 `~/.hermes-ts/sessions.db`。

## 测试

```bash
pnpm test         # vitest run（全部单测）
pnpm typecheck    # 全包 tsc --noEmit
```

## 项目结构

```
packages/
  core/        @hermes/core      类型 / 配置 / 日志 / SessionDB
  providers/   @hermes/providers Provider 抽象 + OpenAI 兼容客户端 + GLM
  tools/       @hermes/tools     ToolRegistry + 工具集(Toolsets) + 内置工具
  agent/       @hermes/agent     ConversationLoop
apps/
  cli/         @hermes/cli       readline REPL（bin: hermes-ts）
docs/superpowers/
  specs/       设计文档
  plans/       实现计划
```

依赖方向：`core ← providers ← agent ← cli`，`tools` 也被 `agent` 依赖。内部包指向源码解析（无需先 build）。

## 故障排查

- **better-sqlite3 安装失败 / 原生模块缺失**：预编译二进制从 GitHub CDN 拉取偶发 ECONNRESET。可重试 `pnpm install`；仍失败则需要 C++ 工具链让 node-gyp 从源码编译，或手动获取对应 ABI 的预编译 `.node`。根 `package.json` 的 `pnpm.onlyBuiltDependencies` 已允许其构建。

## 路线图

阶段 1（核心代理）✅ → 阶段 2（工具系统）✅ → 阶段 2.5（命令审批）✅ → 阶段 3a（记忆系统）✅ → 阶段 3b（session_search 全文搜索）✅ → 技能系统（自进化，下一步）→ 4 完整 CLI/TUI → 5 MCP/Cron/委派 → 6 网关（Telegram 等）→ 7 ACP/Web/批量轨迹。

设计与计划见 `docs/superpowers/`。

## 已知限制（当前）

- 工具均为本地执行；尚无远程终端后端（docker/ssh，后续阶段）
- 无 web/vision/browser 等外部依赖工具（后续阶段）
- 无上下文压缩 / 无重试降级（后续阶段）
- 跨会话记忆已支持（`memory` 工具 + system prompt 注入）；跨会话全文搜索已支持（`session_search` 工具，阶段 3b）；技能系统（自进化）仍未实现（后续阶段）
- 仅支持 GLM provider（Provider 抽象已就绪，加新 provider 只需新增实现）
