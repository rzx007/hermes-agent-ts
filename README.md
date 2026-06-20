# Hermes Agent TS

用 TypeScript 复刻 [Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent)（原项目为 Python）。**架构级对齐 + 惯用 TS 重写**，分阶段推进。

## 当前状态：阶段 1（核心代理 MVP）✅

一个能跑通「对话 → 工具调用 → 多轮循环 → 会话持久化」的最小可用 AI 代理。

- **@hermes/core** — 核心类型、`~/.hermes` 路径、配置加载、pino 日志、SQLite 会话持久化（SessionDB）
- **@hermes/providers** — Provider 抽象 + OpenAI 兼容流式客户端（含流式 tool_call 分片聚合）+ GLM 工厂
- **@hermes/tools** — ToolRegistry（Zod schema → JSON Schema，安全调用）+ 内置工具 `read_file` / `write_file` / `terminal`
- **@hermes/agent** — ConversationLoop 核心循环（流式、工具循环、落库、中断、maxIterations 守卫）
- **@hermes/cli** — readline REPL（`/new` `/exit` `/help`，流式渲染，Ctrl+C 中断）

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

也可用 `~/.hermes/config.yaml`（env 优先）。

## 运行

```bash
pnpm cli          # 启动交互式 CLI（hermes-ts）
```

进入后直接输入对话；斜杠命令：`/new` 新会话、`/exit` 退出、`/help` 帮助。会话历史持久化在 `~/.hermes/sessions.db`。

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
  tools/       @hermes/tools     ToolRegistry + 内置工具
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

阶段 1（核心代理）✅ → 2 工具系统/终端后端 → 3 记忆+技能 → 4 完整 CLI/TUI → 5 MCP/Cron/委派 → 6 网关（Telegram 等）→ 7 ACP/Web/批量轨迹。

设计与计划见 `docs/superpowers/`。

## 已知限制（阶段 1）

- `terminal` 工具无命令审批/白名单（后续阶段加）
- 无上下文压缩 / 无重试降级 / 无记忆与技能系统（后续阶段）
- 仅支持 GLM provider（Provider 抽象已就绪，加新 provider 只需新增实现）
