# Hermes Agent TS — 阶段路线图与功能清单

> **这是项目的"全局记忆"文档**。每完成或规划一个阶段就更新此处:该阶段做了什么、MVP 覆盖了什么、哪些功能明确推迟到后续。目的是让任何人(包括 AI 助手)无需翻阅长对话即可掌握全貌。
>
> 维护约定:每个阶段在合并前更新对应小节的状态与「已做/推迟」清单。详细设计见 `docs/superpowers/specs/`,实现计划见 `docs/superpowers/plans/`。

## 项目定位

用 TypeScript 完整复刻 [Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent)(原为 Python,~270K 行)。保真度:**架构级对齐 + 惯用 TS 重写**(保留模块边界与工作流,内部用地道 TS,不强求与 Python 版磁盘格式兼容)。分阶段推进,每阶段独立走「头脑风暴 → spec → 计划 → subagent 驱动实现 → 评审 → 合并」。

**技术栈**:Node 20+ · TypeScript(strict, noUncheckedIndexedAccess) · pnpm workspace · tsx/tsup · better-sqlite3 · Zod · Vitest · pino · openai SDK。联调模型:GLM/智谱。

**仓库**:https://github.com/rzx007/hermes-agent-ts

---

## 阶段总览

| 阶段 | 主题 | 状态 |
|------|------|------|
| 1 | 核心代理 MVP | ✅ 完成 |
| 2 | 工具系统:Toolsets 分组 + 文件/代码工具 | ✅ 完成 |
| 2.5 | 命令审批 / 安全 | ✅ 完成 |
| — | Terminal 后端(docker/ssh) | ⏸️ 计划 |
| — | Web 工具(web_search/web_extract) | ⏸️ 计划 |
| 3a | 记忆(MemoryStore + memory 工具 + 系统提示注入) | ✅ 完成 |
| 3b | session_search(会话全文搜索) + 技能(自进化) | ⏸️ 计划 |
| 4 | 完整 CLI / TUI | ⏸️ 计划 |
| 5 | MCP / Cron / 委派子代理 | ⏸️ 计划 |
| 6 | 网关(Telegram/Discord/...) | ⏸️ 计划 |
| 7 | ACP / Web 仪表板 / 批量轨迹 | ⏸️ 计划 |

---

## 阶段 1:核心代理 MVP ✅

**目标**:能跑通「对话 → 工具调用 → 多轮循环 → 会话持久化」的最小可用代理。

**已做(MVP)**:
- `@hermes/core`:核心类型(Message/ToolCall/Session)、`~/.hermes-ts` 路径、config 加载(env+yaml)、pino 日志、**SessionDB**(better-sqlite3,WAL,sessions+messages 表,事务化 appendMessage,seq 唯一约束)
- `@hermes/providers`:Provider 抽象 + **OpenAI 兼容流式客户端**(流式 tool_call 分片按 index 聚合;usage/finishReason 真实贯通)+ GLM 工厂
- `@hermes/tools`:**ToolRegistry**(Zod→JSON Schema,call 永不抛错、错误回灌模型)+ `defineTool<T>` 泛型 + 工具 `read_file`/`write_file`/`terminal`(local 后端)
- `@hermes/agent`:**ConversationLoop**(流式 + 工具循环 + 落库 + 中断守卫 + maxIterations;退出判据=有无 toolCalls,不看 finishReason)
- `@hermes/cli`:readline REPL(`/new`/`/exit`/`/help`,流式渲染,Ctrl+C 中断,db.close 全路径)

**推迟到后续**:
- 重试 / 多模型降级(failover)
- 上下文压缩 / token 上限管理
- 记忆、技能、MCP、cron、网关(各自独立阶段)
- 完整 TUI
- 命令审批(→ 阶段 2.5)
- 会话压缩链 / 分支(Session.parentSessionId 已预留)
- FTS5 会话搜索(messages 表结构已预留)

---

## 阶段 2:工具系统(Toolsets + 文件/代码工具) ✅

**目标**:工具集分组过滤 + 让 agent 真正能改代码。

**已做(MVP)**:
- **Toolsets 分组**(`@hermes/tools/toolsets.ts`):`TOOLSETS` 映射(file/terminal/core)+ `resolveToolset`(递归展开/环安全/`all`/`*`)+ `computeEnabledTools`(默认全部、enabled∪、disabled−、与已注册取交集前向兼容)
- `ToolRegistry.getToolNames()`
- 新工具:**`edit_file`**(精确字符串替换,唯一性检查,replaceAll,split/join 防 `$` 损坏)、**`search_files`**(fast-glob,content/filename 双模式,UTF-8 字节上限,忽略 node_modules/.git/dist/dotfile)、**`list_dir`**
- config:`HERMES_ENABLED_TOOLSETS` / `HERMES_DISABLED_TOOLSETS`(逗号分隔)
- agent loop:`deps.toolNames` 过滤暴露工具
- CLI:`computeEnabledTools` 接线 + 未知 toolset 警告 + `/tools` 命令

**约定(本阶段确立)**:`ToolDef.toolset` 字段为信息性,`TOOLSETS` 映射才是分组解析权威;`'all'`/`'*'` 是 resolveToolset 保留名。

**推迟到后续**:
- 更多工具:web/vision/browser/image_gen/delegate/execute_code 等
- Terminal 后端抽象(docker/ssh,见独立阶段)
- search_files 提速(可换 ripgrep)、按大小写/多行选项
- toolset 反向查找(tool→toolset,Python 有 TOOL_TO_TOOLSET_MAP)

---

## 阶段 2.5:命令审批 / 安全 ✅

**目标**:补上阶段 1 留下的 terminal 安全缺口——危险命令在执行前需用户审批。

**已做(MVP)**:
- **危险模式检测**:精选正则清单(~20 条:`rm -rf /`、`chmod 777`、`mkfs`、`dd`、`curl|sh`、fork bomb、写 `/etc`、`~/.ssh` 等)
- **hardline 永禁**:3-5 条最致命的,任何模式都阻止(连 off 也绕不过)
- **交互审批**:命中危险模式 → CLI 提示 `[o]nce / [s]ession / [a]lways / [d]eny`
- **白名单**:`session`(内存)+ `always`(持久化到 `~/.hermes-ts/allowlist.json`)
- **模式**:`manual`(默认,危险才提示)/ `off`(=`HERMES_YOLO_MODE`,全放行但 hardline 仍拦)
- **作用范围:仅 terminal 工具**
- **架构**:`ToolContext.approval`(ApprovalGuard 对象)注入工具上下文;readline 审批回调封装在 guard 内;无 guard/无 prompt 环境按策略默认(危险命令拒绝)

**明确不做(推迟)**:
- smart LLM 审批(辅助模型自动判低风险)
- gateway 异步审批队列 + contextvar 并发隔离
- cron 专用路由(cron_mode)
- execute_code 守卫
- 文件写入审批(write_file/edit_file 审批)
- tirith 外部安全扫描、plugin hooks

---

## Terminal 后端(docker/ssh) ⏸️

**目标**:把 terminal 从 local 单后端抽象成 `Backend` 接口,支持容器/远程执行。

**计划做**:`Backend` 接口(execute/init/cleanup)、`local` 重构、`docker` 后端(容器生命周期)、`ssh` 后端(连接复用 + 文件同步)。`TERMINAL_ENV` 选择后端。
**推迟**:modal/daytona/singularity 等云后端。

---

## Web 工具 ⏸️

**计划做**:`web_search`、`web_extract`(归入新 `web` toolset)。需搜索 API key。

---

## 阶段 3:记忆 + 技能(自进化)

hermes 的标志性"自进化"能力。因记忆与技能各自较大,拆成 3a(记忆,已完成)/ 3b(session_search + 技能,推迟)两个子阶段。

### 阶段 3a:记忆 ✅

**目标**:跨会话的持久记忆——agent 主动记、每轮注入。

**已做(MVP)**:
- **MemoryStore**(`@hermes/core`):`MEMORY.md`(agent 长期笔记,上限 2200 字)/ `USER.md`(用户画像,上限 1375 字)持久化,条目以 `§` 分隔,`add` / `replace` / `remove` / `getEntries` / `render`;超限需先删旧条目
- **memory 工具**(`@hermes/tools/builtin/memory.ts`):暴露给模型,支持 add / replace / remove 操作
- **memory toolset**:`TOOLSETS.memory = ['memory']`,并入 `core`
- **系统提示注入**:每轮把两类记忆 `render()` 注入 system prompt,实现跨会话记忆
- **paths.memoriesDir**:`~/.hermes-ts/memories/`(MEMORY.md / USER.md)

### 阶段 3b:session_search + 技能 ⏸️ 推迟

**计划做**:
- 记忆:FTS5 会话全文搜索(`session_search` 工具,messages 表结构已预留)
- 技能:技能加载、`skills`/`skill_view`/`skill_manage` 工具、技能内容注入系统提示、后台技能自改进

---

## 阶段 4:完整 CLI / TUI ⏸️

**计划做**:增强斜杠命令(/model /retry /undo /compress /usage 等)、复用已有 `ui-tui`(Ink/React)做完整 TUI。

---

## 阶段 5:MCP / Cron / 委派 ⏸️

**计划做**:MCP 客户端集成(连接外部 MCP server)、cron 调度器、委派子代理(delegate_task)。

---

## 阶段 6:网关 ⏸️

**计划做**:Gateway 主循环 + 平台适配器(Telegram 优先 → Discord/Slack/...)。跨平台会话路由。

---

## 阶段 7:外围 ⏸️

**计划做**:ACP 适配器、Web 仪表板、批量轨迹生成、轨迹压缩器。

---

## 跨阶段:已知技术债 / 待清理

非阻塞的小项,可在相关阶段顺手清理:
- agent 测试里的 mock `aggregate` 与真实 `aggregateChunks` 重复且已漂移(缺 sort)
- CLI 双 SIGINT 处理(turn 级 + idle 级)可统一
- `config.ts` 一处 `Record<string, any>`(yaml 解析)
- conversation-loop 顶部 ASCII 注释里写的是旧的 `getSchemas()`(实际已是 `getSchemas(deps.toolNames)`)

## 跨阶段:已知限制(当前)

- 工具均本地执行,无远程后端
- 无 web/vision/browser 等外部依赖工具
- 无上下文压缩 / 无重试降级
- 跨会话记忆已支持(memory 工具 + 系统提示注入);但无 session 全文搜索(`session_search`,阶段 3b);无技能系统
- 仅 GLM provider(抽象已就绪,加新 provider 只需新增实现)

## 运维备忘

- HERMES_HOME = `~/.hermes-ts`(避免与 Python 版 `~/.hermes` 冲突)
- 命令审批白名单(`always` 永久放行)持久化在 `~/.hermes-ts/allowlist.json`
- 记忆持久化在 `~/.hermes-ts/memories/`(MEMORY.md / USER.md)
- `better-sqlite3` 预编译二进制从 GitHub CDN 拉取偶发 ECONNRESET;根 `package.json` 的 `pnpm.onlyBuiltDependencies` 已允许其构建,失败可重试或用 C++ 工具链编译
- GLM 端点按 Key 来源:智谱开放平台 `https://open.bigmodel.cn/api/paas/v4`;GLM Coding Plan(z.ai)`https://api.z.ai/api/coding/paas/v4`
- 每阶段开工前先实测基线 `pnpm vitest run` 是否全绿(用户可能在会话间自行向 main 提交改动)
