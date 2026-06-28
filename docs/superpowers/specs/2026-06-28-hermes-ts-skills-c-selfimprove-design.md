# 技能 c-1：自改进 review（后台异步）设计

> 阶段：技能系统第三步（自进化）。承接技能 a（只读）+ 技能 b-1（skill_manage CRUD），新增「后台自改进」——agent 在合适的轮次后自动复盘会话、用 skill_manage 提炼/精炼技能。
> 日期：2026-06-28
> 保真度：架构级对齐 Python 原版 `agent/turn_finalizer.py` + `agent/background_review.py` 的 skill-review 部分，惯用 TS 重写。

## 目标

一句话：某轮工具迭代数达到阈值后，回复发给用户之后立即在后台跑一个「技能自改进 review」——它复盘本会话、用 `skill_manage` 创建或精炼技能，不阻塞用户、不写用户会话、不抢占用户输出。

## 范围

### 本次做
- 自动触发：`ConversationLoop` 统计本轮工具迭代数；repl 在 `turn_done` 后判定是否够阈值。
- 后台异步执行：满足条件即 fire-and-track 一个 review，不 await，不阻塞下一条用户输入。
- 独立 review runner（`runSkillReview`）：聚焦的后台工具循环，只给技能工具、喂 review 系统提示、不持久化、不流式输出给用户。
- 安全：后台禁删技能（无审批通道 → `skill_manage delete` 被 `confirm()` 挡下）。
- 完成后一行提示；`/exit`、`/new` 前 await in-flight review。

### 本次不做（留后续阶段）
- **provenance**（`.usage.json` 标 `agent_created`，区分用户建/agent 建）——只为 curator 服务，无 curator 则无意义。
- **curator**（生命周期 active/stale/archived 自动归档/合并）。
- **技能支持文件**（`write_file`/`remove_file` 写 references/templates/scripts/assets）。
- **记忆自改进**（本次只自改进**技能**，不动 memory）。
- 流式 review 进度展示、verbose 模式。

## 架构

**独立 review runner，不污染 ConversationLoop。** 新建 `packages/agent/src/skill-review.ts`，写一个聚焦的后台工具循环（复用 `provider` + `registry`，但与主循环解耦）：不读写用户会话 DB、不向用户 stdout 流式输出、只暴露技能工具、用 review 专用系统提示。

理由：现有 `runConversation` 紧耦合持久化（每步 `db.appendMessage`）与常规 `buildSystemPrompt`，并以 `userText` 为入口。硬塞 review 标志（systemPromptOverride / persist:false / quiet）会污染它、混淆职责。独立 runner 边界清晰、可独立测试。两者都用 `provider.complete` + `provider.aggregate` + `registry.call`，少量循环骨架重复可接受（YAGNI：暂不提前抽象共享核）。

### 文件改动
| 文件 | 改动 |
| --- | --- |
| `packages/agent/src/skill-review.ts` | 新建：`runSkillReview()` + `REVIEW_PROMPT` + `shouldTriggerReview()` 纯函数 + `ReviewSummary` 类型 |
| `packages/agent/src/events.ts` | `turn_done` 事件加 `iterations: number` |
| `packages/agent/src/conversation-loop.ts` | 统计本轮 `toolCalls.length>0` 的迭代数，随 `turn_done` 抛出 |
| `packages/agent/src/index.ts` | 导出 `runSkillReview` / `shouldTriggerReview` / `ReviewSummary` |
| `packages/core/src/config.ts` | `skillNudgeInterval`（`HERMES_SKILL_NUDGE_INTERVAL`，默认 10，0=关） |
| `apps/cli/src/repl.ts` | 触发接线：计数 → 后台跑 → 完成打一行 → 退出/新会话前 await in-flight |
| `README.md` / `docs/ROADMAP.md` | 技能 c-1 ✅，注明后续推迟项 |

## 组件设计

### ① ConversationLoop 暴露迭代数（@hermes/agent）

`events.ts` 的 `turn_done` 事件加字段：`{ type: 'turn_done'; result: CompletionResult; iterations: number }`。

`conversation-loop.ts`：循环内维护计数器，每当 `result.toolCalls.length > 0`（即本轮执行了工具、要再转一圈）就 `+1`；在 `turn_done` 时一并 yield。语义 = 「本次用户输入触发了多少轮工具调用」。（纯文本直接收尾的轮次 iterations=0。）

### ② review runner（`runSkillReview`，@hermes/agent）

```ts
export interface ReviewDeps {
  provider: Provider;
  registry: ToolRegistry;
  model: string;
  maxIterations?: number; // 默认 16
  logger?: Logger;
}
export interface ReviewSummary {
  actions: string[];   // 执行过的 skill_manage 结果串，如 ['已创建技能 "x"。']
  iterations: number;
  error?: string;      // best-effort：内部异常记此处，不抛
}
export async function runSkillReview(
  deps: ReviewDeps,
  snapshot: Message[],   // = db.getMessages(sessionId)
  ctx: ToolContext,      // { cwd, logger, skills, approval:<无 prompt 的 guard> }（无 db）
): Promise<ReviewSummary>
```

流程：
1. 构建 `messages = [{role:'system', content: REVIEW_PROMPT}, ...snapshot, {role:'user', content: REVIEW_INSTRUCTION}]`。
2. `tools = registry.getSchemas(['skill_view', 'skill_manage'])`（仅技能工具）。
3. 工具循环（≤ maxIterations）：`provider.complete({model, messages, tools, signal})` 逐 chunk **丢弃 delta**（不 yield、不打印）→ `provider.aggregate` → 把 assistant 消息 push 进 messages（**不落库**）。
   - `result.toolCalls.length === 0` → 结束。
   - 否则逐个 `registry.call(call.name, call.arguments, ctx)`；记录成功的 skill_manage 输出到 `actions`；把 tool 结果 push 进 messages。
4. 返回 `ReviewSummary`。
5. **整个函数体 try/catch**：任何异常 → `logger?.warn` + 返回 `{actions, iterations, error}`（best-effort，绝不外抛影响用户主流程）。

**安全**：调用方传入的 `ctx.approval` 是一个 **mode `manual`、无 prompt 回调** 的 `ApprovalGuard`，故 `skill_manage` 的 `delete` 分支 `confirm()` 返回 `{allowed:false}` → 后台**不能删技能**（返回拒绝串，不删）。create/edit/patch 不经审批，照常执行（与前台一致）。SkillStore 是与主流程**同一个实例** → 后台新建/精炼的技能立即热更新，下一轮用户对话的 system prompt 索引即可见。

### ③ 触发（repl 侧，apps/cli）

纯函数（放 skill-review.ts，便于单测）：
```ts
export function shouldTriggerReview(iterations: number, interval: number, enabledTools: string[]): boolean {
  return interval > 0 && iterations >= interval && enabledTools.includes('skill_manage');
}
```

repl 接线：
- 消费 loop 事件时取 `turn_done.iterations`。
- turn 正常结束（非中断）且 `shouldTriggerReview(...)` 为真且**当前无 in-flight review**：
  - 取 `snapshot = deps.db.getMessages(sessionId)`；构建 review `ctx`（复用每轮 ctx 的 cwd/logger/skills，但 `approval` 换成无 prompt 的 guard，且不含 db）；
  - `inFlight = runSkillReview(reviewDeps, snapshot, reviewCtx).then(printSummary)`，**不 await**；
  - 完成回调：若 `summary.actions.length` 打一行 `💾 自改进:<actions join>`；否则静默（或 debug 日志）。
- 重叠保护:若已有 in-flight，跳过本次触发。
- `/exit` 与 `/new`：先 `await inFlight`（若有）再继续，避免后台写到一半被打断 / promise 泄漏。

### ④ config（@hermes/core）

`config.ts` 加 `skillNudgeInterval: number`：读 `HERMES_SKILL_NUDGE_INTERVAL`（解析失败/缺省 → 10；`0` 表示关闭自改进）。沿用现有 config 解析风格。

### ⑤ REVIEW_PROMPT / REVIEW_INSTRUCTION

系统提示要点（中文）：你是技能库维护者，复盘上面的对话；**主动**——多数会话至少能产出一条小更新。值得更新的信号（任一即可动手）：① 用户纠正了风格/语气/做法 → 把偏好写进相关技能；② 出现非平凡的技巧/修复/绕法 → 记下供复用；③ 已加载/相关技能过时或缺失 → 立即 patch。优先级：先 patch 已加载/已有技能，其次新建 **class 级**技能（名字要泛化，不能是一次性任务名/PR 号/报错串）。**不要**记录：环境瞬时错误、对工具的否定断言、一次性任务叙事。没有值得记的就什么都不做并明说。

instruction（user 消息）：「复盘上面的对话并据此更新技能库（用 skill_view 查看、skill_manage 创建/编辑/patch）。没有值得保存的就回复"无需更新"。」

## 数据流

```
用户输入 → runConversation（多轮工具）→ turn_done{iterations=N}
  repl: N>=interval 且 skill_manage 启用 且 无 in-flight
    → snapshot = db.getMessages(sid)
    → runSkillReview(reviewDeps, snapshot, reviewCtx)  [不 await，后台]
         system=REVIEW_PROMPT + snapshot + user=instruction
         → provider.complete（丢 delta）→ aggregate
         → skill_manage(create/patch...) 经 registry.call（delete 被 guard 挡）
         → SkillStore 热更新（同实例）→ 下一轮 system prompt 索引立即含新技能
    → 完成：actions 非空则打 "💾 自改进:..."
用户继续输入（期间 review 在后台跑，互不阻塞）
/exit、/new → await in-flight review
```

## 错误处理
- review 全程 best-effort：runner 内 try/catch，异常 → warn + 空/部分 summary，**绝不影响用户主流程**。
- max 迭代到顶即止（返回已有 actions）。
- 后台无审批通道 → delete 被挡（返回拒绝串，计入 actions 但技能未删；或不计入——见测试约定：delete 被挡不算成功 action）。
- repl 触发包一层 try/catch：构建 review 失败也不影响主循环。

## 测试
- `runSkillReview`（假 provider）：
  - provider 返回一个 `skill_manage create` 工具调用 + 收尾文本 → 真 SkillStore（临时目录）断言技能被建、`summary.actions` 含「已创建」。
  - provider 返回 `skill_manage delete` → 技能仍在（被无 prompt guard 挡）、不计入成功 actions。
  - provider 连续返回工具调用 → 达 `maxIterations` 即停。
  - provider 抛错 → 返回 `{error}`、不崩、actions 为空。
  - 不写 DB：runner 不接收 db，断言无持久化副作用（不传 db 即可）。
- `shouldTriggerReview` 纯函数：interval=0 关闭 / iterations<interval / 缺 skill_manage / 满足 四分支。
- `conversation-loop`：构造多轮工具的假 provider，断言 `turn_done.iterations` 计数正确；纯文本轮 iterations=0。

## 验收标准（DoD）
- 新增测试约 12+，全部通过。
- 全包 `tsc --noEmit` 干净。
- README + ROADMAP 更新（技能 c-1 ✅；provenance/curator/支持文件/记忆自改进 标注推迟）。
- 不破坏既有 202 测试。
