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
| 3b | session_search(会话全文搜索) | ✅ 完成 |
| 技能 a | 只读技能:SkillStore + skill_view + 索引注入 | ✅ 完成 |
| 技能 b-1 | skill_manage CRUD(create/edit/patch/delete)+ 热更新 + delete 审批 | ✅ 完成 |
| 技能 c-1 | 自改进 review(后台异步,达阈值复盘→skill_manage) | ✅ 完成 |
| 技能 c-2 | provenance(.usage.json)+ curator 归档(启动/手动) | ✅ 完成 |
| 技能 c-3 | curator 合并(LLM)+ 技能支持文件 + 记忆自改进 | ⏸️ 计划 |
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

hermes 的标志性"自进化"能力。因记忆与技能各自较大,拆成 3a(记忆,已完成)/ 3b(session_search,已完成)/ 技能 a(只读技能,已完成)/ 技能 b-1(skill_manage CRUD,已完成)/ 技能 c(自改进 + curator,推迟)等子阶段。

### 阶段 3a:记忆 ✅

**目标**:跨会话的持久记忆——agent 主动记、每轮注入。

**已做(MVP)**:
- **MemoryStore**(`@hermes/core`):`MEMORY.md`(agent 长期笔记,上限 2200 字)/ `USER.md`(用户画像,上限 1375 字)持久化,条目以 `§` 分隔,`add` / `replace` / `remove` / `getEntries` / `render`;超限需先删旧条目
- **memory 工具**(`@hermes/tools/builtin/memory.ts`):暴露给模型,支持 add / replace / remove 操作
- **memory toolset**:`TOOLSETS.memory = ['memory']`,并入 `core`
- **系统提示注入**:每轮把两类记忆 `render()` 注入 system prompt,实现跨会话记忆
- **paths.memoriesDir**:`~/.hermes-ts/memories/`(MEMORY.md / USER.md)

### 阶段 3b:session_search ✅

**目标**:跨会话历史的全文搜索——agent 能检索过往会话内容。

**已做(MVP)**:
- **SessionDB trigram FTS5**(`@hermes/core/session-db.ts`):`messages_fts` 虚拟表(trigram tokenizer,支持中文子串/≥3 字符)+ insert/delete **触发器**(只索引 user/assistant 消息)+ 建表时**幂等回填**历史数据(`IF NOT EXISTS`,对现有 DB 安全)
- **searchMessages / browseSessions**(SessionDB 方法):前者返回带高亮 snippet 的命中;后者(省略 query 时)返回最近会话预览
- **session_search 工具**(`@hermes/tools/builtin/session-search.ts`):暴露给模型;有 query 走搜索、无 query 走浏览;query<3 字符给提示;无 `ctx.sessionDb` 返回「不可用」;多会话按 sessionId 去重
- **sanitizeFtsQuery**(`@hermes/tools/fts-query.ts`):把查询当**字面短语**包裹,杜绝 FTS5 语法注入
- **search toolset**:`TOOLSETS.search = ['session_search']`,并入 `core`
- **接线**:`ToolContext.sessionDb?: SessionDB`(可选,不注入即「不可用」);CLI 每轮注入 `sessionDb: deps.db`(沿用 memory/approval 模式)

### 技能 a:只读技能 ✅

**目标**:让 agent 拥有可复用的「技能」(程序性知识)——启动时加载、索引注入系统提示、按需读取正文。

**已做(MVP)**:
- **SkillStore**(`@hermes/core/skill-store.ts`):递归扫描技能目录,解析 `SKILL.md`(frontmatter `name`/`description` + 正文),按目录分类,重名/解析失败 warn 后跳过;`list` / `getContent` / `renderIndex`
- **skill_view 工具**(`@hermes/tools/builtin/skills.ts`):暴露给模型,按名读取技能正文;无 `ctx.skills` 返回「不可用」,未找到列出可用技能名
- **skills toolset**:`TOOLSETS.skills = ['skill_view']`,并入 `core`
- **系统提示注入**:每轮把技能索引(name + description,按分类)`renderIndex()` 注入 system prompt
- **paths.skillsDir**:`~/.hermes-ts/skills/`(`<name>/SKILL.md`)
- **接线**:`ToolContext.skills?: SkillStore`;CLI 启动建 SkillStore、每轮注入 `skills: deps.skills`(沿用 memory/session_search 模式)

### 技能 b-1:skill_manage CRUD ✅

**目标**:让 agent 能创建/编辑/删除技能(写入侧),写入即时热更新,delete 走审批确认。

**已做(MVP)**:
- **SkillStore 变更 API**(`@hermes/core/skill-store.ts`):`create`(校验 name/category/frontmatter/正文/大小、唯一性、原子写、部分失败回滚新建目录)/ `edit`(整体重写,frontmatter name 不可变,就地同步)/ `patch`(精确替换,split/join 防 `$` 损坏、唯一性、改后仍须合法、不可改 name)/ `delete`(三重路径安全:根内/非根/非 symlink);写盘后**即时热更新**内存索引(`skills[]`/`byName` 共享同一对象就地改)
- **校验纯函数**:`validateSkillName`(`^[a-z0-9][a-z0-9._-]*$`,≤64)/ `validateCategory`(单段)/ `validateAndParseContent`(frontmatter 必含 name+description、desc≤1024、正文非空、≤100k 字符)
- **ApprovalGuard.confirm()**(`@hermes/tools/approval.ts`):通用确认(**不走** detectDangerous),复用同一 prompt 回调与 allowlist;供 delete 确认(off 放行 / 无通道阻止 / deny 阻止 / session·always 记忆)
- **skill_manage 工具**(`@hermes/tools/builtin/skills.ts`):create/edit/patch/delete 分发,必填参校验抛错回灌模型,delete 经 `ctx.approval.confirm` 确认(被拒返回原因、不删);归入 `skills` toolset(已并入 `core`)
- **接线**:复用技能 a + 阶段 2.5 既有注入(`LoopDeps.skills` / `ctx.skills` / `ctx.approval`),无需改 loop/repl/main——同一个 SkillStore 实例,热更新天然贯通 system prompt 与工具

### 技能 c-1:自改进 review ✅

**目标**:某轮工具迭代数达阈值后,回复发出即在后台复盘本会话,用 `skill_manage` 自动创建/精炼技能——不阻塞用户、不写用户会话、不抢占输出。

**已做(MVP)**:
- **runSkillReview**(`@hermes/agent/skill-review.ts`):独立后台工具循环,复用 provider+registry,**不持久化/不流式输出**,只给 `skill_view`+`skill_manage`,喂 review 专用系统提示;best-effort(整体 try/catch,异常不外抛,返回 `{actions, iterations, error?}`);成功的 skill_manage 动作收入 `actions`。
- **触发**:`turn_done` 暴露本轮工具迭代数;`shouldTriggerReview(iterations, interval, enabledTools)` 纯函数(阈值>0 且达标且 `skill_manage` 启用);repl 在正常收尾(非中断)后 fire-and-track,**不 await**,重叠跳过,`/exit`·`/new` 前 await in-flight(SIGINT 硬退出不 await,best-effort 取舍)。
- **安全**:repl 另建一个**无 prompt + 独立空 allowlist** 的 `ApprovalGuard` 专供 review → 后台 `skill_manage delete` 必被 `confirm()` 挡下(自改进只增/精炼,**不删**);create/edit/patch 照常。
- **config**:`skillNudgeInterval`(`HERMES_SKILL_NUDGE_INTERVAL`,默认 10,`0`=关闭;解析特判 0 不走 `||`)。
- **热更新**:与主流程**同一 SkillStore 实例**,自改进成果下一轮系统提示索引即可见。
- **接线零侵入主循环**:runner 独立于 `ConversationLoop`,只在 repl 收尾处接。

### 技能 c-2:provenance + curator 归档 ✅

**目标**:技能库记住每条技能的来源与使用情况,并在 CLI 启动时(及 `/curate`)自动把「agent 自建且久未使用」的技能归档;用户手建技能永不自动归档。

**已做(MVP)**:
- **SkillUsage**(`@hermes/core/skill-usage.ts`):`.usage.json` sidecar,`create`(身份事件,整条覆盖,重置 agentCreated/state/counts/时间戳)/ `record`(变更,就地改,永不动 agentCreated,缺条目以 agentCreated=false 新建)/ `remove`/`get`/`entries`;原子写,加载容错(缺/坏 → 空)。**缺条目 = 用户建**,永不自动管理。
- **SkillStore 集成**:create 记 provenance(透传 agentCreated,用 `usage.create` 整条覆盖→同名重建重置)、edit/patch 记 patch、delete remove、新增 `recordView`/`usageEntries`;`archive(name)`(三重路径安全,移到 `.archive/<叶名>`,冲突加后缀绝不覆盖,usage state=archived,移出索引);扫描跳过 `.archive`。
- **runCurator**(`@hermes/core/skill-curator.ts`):只归档 `agentCreated && state==='active' && 闲置>阈值`;`now` 可注入;坏时间戳→NaN→不归档;`archiveAfterDays<=0` 关闭;best-effort(单条失败 warn 跳过)。
- **provenance 接线**:`ToolContext.backgroundReview`;`skill_view`→`recordView`;`skill_manage` create→`agentCreated: ctx.backgroundReview ?? false`;`runSkillReview` 在 `registry.call` 处注入 `backgroundReview:true`(唯一真相源,前台→用户建,后台→agent 建)。
- **config**:`skillArchiveDays`(`HERMES_SKILL_ARCHIVE_DAYS`,默认 30,`0`=关;`parseIntConfig` 泛化带默认参)。
- **CLI**:启动时跑 curator(best-effort try/catch,归档非空打印 🗃 摘要)+ `/curate` 命令(关闭/无可归档/已归档 三态提示)。

### 技能 c-3:curator 合并 + 支持文件 + 记忆自改进 ⏸️ 推迟

**计划做**:curator 合并/consolidation(用 LLM 把相似/冗余技能合到 umbrella)、技能支持文件(`write_file`/`remove_file` 写 references/templates/scripts/assets)、记忆自改进(review 扩展到 memory)、归档恢复命令、stale 预警态。

---

## 阶段 4:完整 CLI / TUI ⏸️

**计划做**:增强斜杠命令(/model /retry /undo /compress /usage 等)、复用已有 `ui-tui`(Ink/React)做完整 TUI。

---

## 阶段 5:MCP / Cron / 委派 ⏸️

**计划做**:MCP 客户端集成(连接外部 MCP server)、cron 调度器、委派子代理(delegate_task)。

---

## 阶段 6:网关 ⏸️

**计划做**:Gateway 主循环 + 平台适配器(Telegram 优先 → Discord/Slack/...)。跨平台会话路由。

**并发设计要点(本阶段必须处理,提前记录以免遗忘)**:
- **多会话并行的地基已具备**:ConversationLoop 是无全局状态的纯异步生成器(状态全在 deps/ctx 参数),SessionDB 按 session_id 行隔离,Node 单线程 + better-sqlite3 同步天然无进程内竞态。"单进程 + 多个 async 会话"(I/O 并发,多用户等模型)是 Node 最擅长的模型,可直接支撑。
- **需补的两点**:① 共享单例(MemoryStore、ApprovalGuard 当前全局唯一,假设单用户)要改成**按 user_id 键控的注册表**(对应 Python 的 contextvars);② CLI 单 readline 入口要换成"每条入站消息 → 取/建该用户会话 → 跑一个 loop"的多路复用入口。
- **多进程 / CPU 并行**(仅当真需要):SQLite WAL 允许 1 写者 + N 读者,多写者串行化、抢不到写锁会 `SQLITE_BUSY`(better-sqlite3 默认 5s timeout)。届时加 `busy_timeout` pragma + `SQLITE_BUSY` 重试包装,或改"单一进程持有 DB + 其它走 IPC/队列"。同步 API 的大查询/写入会阻塞事件循环,海量并发需并发上限/队列。`appendMessage` 已事务化 + `UNIQUE(session_id,seq)` 兜底,跨进程并发也只会让失败方报错而非写脏。

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
- 跨会话记忆已支持(memory 工具 + 系统提示注入);跨会话全文搜索已支持(`session_search` 工具,阶段 3b);只读技能已支持(SkillStore + `skill_view` + 技能索引注入,技能 a);技能创建/编辑/删除已支持(`skill_manage`,技能 b-1);后台技能自改进已支持(技能 c-1);provenance + 自动归档已支持(技能 c-2);curator 合并、技能支持文件、记忆自改进尚未实现(技能 c-3)
- 仅 GLM provider(抽象已就绪,加新 provider 只需新增实现)

## 运维备忘

- HERMES_HOME = `~/.hermes-ts`(避免与 Python 版 `~/.hermes` 冲突)
- 命令审批白名单(`always` 永久放行)持久化在 `~/.hermes-ts/allowlist.json`
- 记忆持久化在 `~/.hermes-ts/memories/`(MEMORY.md / USER.md)
- 技能存于 `~/.hermes-ts/skills/<name>/SKILL.md`(frontmatter name/description + 正文)
- 后台技能自改进阈值 `HERMES_SKILL_NUDGE_INTERVAL`(默认 10,`0`=关闭);review 用独立无 prompt guard,后台禁删技能
- 技能自动归档 `HERMES_SKILL_ARCHIVE_DAYS`(默认 30,`0`=关闭);归档存 `~/.hermes-ts/skills/.archive/`,只动 agent 自建技能;provenance 在 `~/.hermes-ts/skills/.usage.json`;启动时跑 + `/curate` 手动
- `better-sqlite3` 预编译二进制从 GitHub CDN 拉取偶发 ECONNRESET;根 `package.json` 的 `pnpm.onlyBuiltDependencies` 已允许其构建,失败可重试或用 C++ 工具链编译
- GLM 端点按 Key 来源:智谱开放平台 `https://open.bigmodel.cn/api/paas/v4`;GLM Coding Plan(z.ai)`https://api.z.ai/api/coding/paas/v4`
- 每阶段开工前先实测基线 `pnpm vitest run` 是否全绿(用户可能在会话间自行向 main 提交改动)
