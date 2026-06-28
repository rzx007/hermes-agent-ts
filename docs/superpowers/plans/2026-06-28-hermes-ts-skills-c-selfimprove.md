# 技能 c-1：自改进 review（后台异步）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 某轮工具迭代数达阈值后，回复发给用户之后在后台跑「技能自改进 review」——复盘本会话、用 `skill_manage` 创建/精炼技能，不阻塞用户、不写用户会话、不抢占输出。

**Architecture:** 独立的后台工具循环 `runSkillReview`（复用 provider+registry，不碰 DB、不流式输出、只给技能工具、专用 review 系统提示），由 repl 在 `turn_done` 后按工具迭代数阈值 fire-and-track。后台用一个无 prompt、空 allowlist 的 ApprovalGuard，使 `skill_manage delete` 必被挡（自改进只增/精炼，不删）。

**Tech Stack:** TypeScript(strict, NodeNext, noUncheckedIndexedAccess) · Vitest · 既有 Provider/ToolRegistry/SkillStore/ApprovalGuard。

**Spec:** `docs/superpowers/specs/2026-06-28-hermes-ts-skills-c-selfimprove-design.md`

**基线（开工前确认）:** `npx vitest run` 当前 202 通过、`pnpm -r exec tsc --noEmit` 干净（分支 `phase-skills-c-selfimprove`，已含 spec 提交）。

---

## 重要约定（实现者必读）

- 内部包指向源码（无需 build）；从 `@hermes/core` / `@hermes/providers` / `@hermes/tools` 用 `import type` 引类型。
- 跑测试：`npx vitest run <文件名关键字>`（从仓库根）。`pnpm --filter @hermes/xxx test` 是 NO-OP，别用。
- 全量校验：`pnpm -r exec tsc --noEmit`。
- 提交信息中文 + conventional-commits，body 末尾加一行 trailer：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 真实接口形状（已核对）：
  - `Provider`：`complete(req: {model, messages, tools?, signal?}): AsyncIterable<CompletionChunk>` + `aggregate(chunks): Promise<CompletionResult>`。
  - `CompletionResult = { content: string|null; toolCalls: ToolCall[]; finishReason: string; usage? }`。
  - `ToolCall = { id: string; name: string; arguments: string }`（`call.arguments` 是 JSON 字符串）。
  - `Message`（@hermes/core）：`{ role; content: string|null; toolCalls?; toolCallId?; name? }`。
  - `ToolContext`（@hermes/tools）：`{ cwd; signal?; logger; approval?; memory?; sessionDb?; skills? }`——`logger` 必填，`db`/`sessionDb` 可选。
  - `registry.getSchemas(names?)` / `registry.call(name, rawArgs, ctx)` / `registry.getToolNames()`。
  - skill_manage 成功返回串以「已创建/已更新/已 patch/已删除」开头；失败经 `registry.call` 包成 `Error: ...`；delete 被审批挡返回拒绝串（不以上述前缀开头）。

---

## Task 1：turn_done 暴露工具迭代数

**Files:**
- Modify: `packages/agent/src/events.ts`
- Modify: `packages/agent/src/conversation-loop.ts`
- Test: `packages/agent/src/conversation-loop.test.ts`

- [ ] **Step 1: 写失败测试**

先读 `packages/agent/src/conversation-loop.test.ts`，复用它已有的 fake provider + SessionDB 测试骨架。新增一个用例：构造一个「第一轮返回 1 个工具调用、第二轮返回纯文本」的 fake provider，跑 `runConversation`，收集事件，断言 `turn_done` 事件的 `iterations === 1`；再补一个「直接纯文本收尾」用例断言 `iterations === 0`。断言示例：
```ts
const done = events.find((e) => e.type === 'turn_done');
expect(done && done.type === 'turn_done' ? done.iterations : -1).toBe(1);
```
（若该文件已有多轮工具的 fake provider 用例，直接在其断言里加 `iterations` 检查即可。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run conversation-loop`
Expected: FAIL（`turn_done` 上无 `iterations` / 类型错误）。

- [ ] **Step 3: 实现**

`events.ts`：给 `turn_done` 加 `iterations`：
```ts
  | { type: 'turn_done'; result: CompletionResult; iterations: number }
```

`conversation-loop.ts`：在 `for (let iteration...)` 之前声明计数器，无工具收尾时带出，有工具时自增。具体改动：
- 在第 86 行 `for (let iteration = 0; ...)` 之前加：`let toolIterations = 0;`
- 把无工具分支（当前 107-110 行）改为：
```ts
      if (result.toolCalls.length === 0) {
        yield { type: 'turn_done', result, iterations: toolIterations };
        return;
      }
      toolIterations++;
```
（`toolIterations++` 放在确认有工具调用之后、执行工具的 `for` 之前。语义=本次输入触发的工具轮数；纯文本收尾轮不计。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run conversation-loop`
Expected: PASS。

- [ ] **Step 5: 全量校验 + 提交**

```bash
pnpm -r exec tsc --noEmit
git add packages/agent/src/events.ts packages/agent/src/conversation-loop.ts packages/agent/src/conversation-loop.test.ts
git commit -m "$(printf 'feat(agent): turn_done 暴露本轮工具迭代数 iterations\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```
Expected: tsc 干净（注意:repl.ts 消费 turn_done 时未读 iterations，新增必填字段不影响其解构——若 tsc 报 repl 构造 turn_done 则不应发生，因 repl 只读不构造）。

---

## Task 2：config.skillNudgeInterval（0=关闭）

**Files:**
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/src/config.test.ts`

- [ ] **Step 1: 写失败测试**

读 `packages/core/src/config.test.ts`，**必须复用其 `HOME()` hermetic 助手**（`const HOME = () => ({ HERMES_HOME: mkdtempSync(...) })`，文件已定义）——每个新用例都要 `...HOME()` 展开，否则会读到开发者真实的 `~/.hermes-ts/config.yaml` 致「默认 10」用例不稳定；并沿用 `as NodeJS.ProcessEnv` 转换以与既有用例一致。新增用例：
```ts
test('skillNudgeInterval 默认 10', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k' } as NodeJS.ProcessEnv).skillNudgeInterval).toBe(10);
});
test('skillNudgeInterval 读 env', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k', HERMES_SKILL_NUDGE_INTERVAL: '5' } as NodeJS.ProcessEnv).skillNudgeInterval).toBe(5);
});
test('skillNudgeInterval=0 表示关闭(不被默认覆盖)', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k', HERMES_SKILL_NUDGE_INTERVAL: '0' } as NodeJS.ProcessEnv).skillNudgeInterval).toBe(0);
});
test('skillNudgeInterval 非法值回退 10', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k', HERMES_SKILL_NUDGE_INTERVAL: 'abc' } as NodeJS.ProcessEnv).skillNudgeInterval).toBe(10);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run config`
Expected: FAIL（`skillNudgeInterval` 不存在）。

- [ ] **Step 3: 实现**

`config.ts`：
- `HermesConfig` 接口加：`skillNudgeInterval: number;`
- 在 `loadConfig` 内加一个 **不走 `||`** 的解析（`||` 会把 `'0'` 当 falsy 回退到默认，破坏「0=关闭」）：
```ts
  const parseInterval = (v: string | undefined, fileVal: unknown): number => {
    if (v !== undefined && v.trim() !== '') {
      const n = Number(v);
      return Number.isNaN(n) ? 10 : n;
    }
    if (typeof fileVal === 'number') return fileVal;
    return 10;
  };
```
- 在 return 对象里加：
```ts
    skillNudgeInterval: parseInterval(env.HERMES_SKILL_NUDGE_INTERVAL, fromFile.skillNudgeInterval),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run config`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/config.ts packages/core/src/config.test.ts
git commit -m "$(printf 'feat(core): config.skillNudgeInterval(HERMES_SKILL_NUDGE_INTERVAL,0=关闭)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3：runSkillReview + shouldTriggerReview（核心 runner）

**Files:**
- Create: `packages/agent/src/skill-review.ts`
- Modify: `packages/agent/src/index.ts`
- Test: `packages/agent/src/skill-review.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `packages/agent/src/skill-review.test.ts`：
```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@hermes/core';
import { SkillStore, createLogger } from '@hermes/core';
import type { Provider, CompletionResult } from '@hermes/providers';
import { ToolRegistry, registerBuiltins, ApprovalGuard, type ToolContext } from '@hermes/tools';
import { runSkillReview, shouldTriggerReview } from './skill-review.js';

// 脚本化 fake provider：complete 记录收到的 messages、不产 chunk；aggregate 依次吐 results
function scripted(results: CompletionResult[]): { provider: Provider; seen: Message[][] } {
  const seen: Message[][] = [];
  let i = 0;
  const provider: Provider = {
    name: 'fake',
    async *complete(req) { seen.push(req.messages.map((m) => ({ ...m }))); /* 无 chunk */ },
    async aggregate() { const r = results[Math.min(i, results.length - 1)]!; i++; return r; },
  };
  return { provider, seen };
}
const tc = (id: string, name: string, args: object) => ({ id, name, arguments: JSON.stringify(args) });
const SKILL = (name: string) => `---\nname: ${name}\ndescription: d\n---\n\n正文`;

let dir: string;
let skills: SkillStore;
let registry: ToolRegistry;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-review-'));
  skills = new SkillStore(dir);
  registry = new ToolRegistry();
  registerBuiltins(registry);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function reviewCtx(approval?: ApprovalGuard): ToolContext {
  return { cwd: process.cwd(), logger: createLogger('test'), skills, approval };
}
const snapshot: Message[] = [
  { role: 'user', content: '帮我改三个文件' },
  { role: 'assistant', content: '改完了' },
];

test('runSkillReview: 模型 create 技能 → 技能被建 + actions 收录', async () => {
  const { provider } = scripted([
    { content: null, toolCalls: [tc('1', 'skill_manage', { action: 'create', name: 'batch-edit', content: SKILL('batch-edit') })], finishReason: 'tool_calls' },
    { content: '已更新技能库。', toolCalls: [], finishReason: 'stop' },
  ]);
  const sum = await runSkillReview({ provider, registry, model: 'm' }, snapshot, reviewCtx());
  expect(skills.getContent('batch-edit')).toContain('正文');
  expect(sum.actions.some((a) => a.startsWith('已创建'))).toBe(true);
  expect(sum.iterations).toBe(1);
});

test('runSkillReview: delete 被无 prompt guard 挡下 → 技能仍在、不计入 actions', async () => {
  skills.create('keep', SKILL('keep'));
  const guard = new ApprovalGuard({ mode: 'manual', allowlistPath: join(dir, 'noallow.json') }); // 无 prompt
  const { provider } = scripted([
    { content: null, toolCalls: [tc('1', 'skill_manage', { action: 'delete', name: 'keep' })], finishReason: 'tool_calls' },
    { content: '完成。', toolCalls: [], finishReason: 'stop' },
  ]);
  const sum = await runSkillReview({ provider, registry, model: 'm' }, snapshot, reviewCtx(guard));
  expect(skills.getContent('keep')).not.toBeNull();
  expect(sum.actions.some((a) => a.startsWith('已删除'))).toBe(false);
});

test('runSkillReview: 消息回环带 toolCallId/name 与 assistant.toolCalls', async () => {
  const { provider, seen } = scripted([
    { content: null, toolCalls: [tc('cx', 'skill_view', { name: 'nope' })], finishReason: 'tool_calls' },
    { content: '完成。', toolCalls: [], finishReason: 'stop' },
  ]);
  await runSkillReview({ provider, registry, model: 'm' }, snapshot, reviewCtx());
  const second = seen[1]!; // 第二次 complete 收到的 messages
  expect(second.some((m) => m.role === 'tool' && m.toolCallId === 'cx' && m.name === 'skill_view')).toBe(true);
  expect(second.some((m) => m.role === 'assistant' && Array.isArray(m.toolCalls))).toBe(true);
});

test('runSkillReview: 达 maxIterations 即停', async () => {
  // 每轮都返回工具调用（无限），maxIterations=2 时只跑 2 轮
  const loopRes: CompletionResult = { content: null, toolCalls: [tc('1', 'skill_view', { name: 'x' })], finishReason: 'tool_calls' };
  const { provider } = scripted([loopRes, loopRes, loopRes, loopRes]);
  const sum = await runSkillReview({ provider, registry, model: 'm', maxIterations: 2 }, snapshot, reviewCtx());
  expect(sum.iterations).toBe(2);
});

test('runSkillReview: provider 抛错 → 返回 error、不崩、actions 空', async () => {
  const provider: Provider = {
    name: 'boom',
    async *complete() { throw new Error('网络炸了'); },
    async aggregate() { return { content: '', toolCalls: [], finishReason: 'stop' }; },
  };
  const sum = await runSkillReview({ provider, registry, model: 'm' }, snapshot, reviewCtx());
  expect(sum.error).toBeTruthy();
  expect(sum.actions).toEqual([]);
});

test('shouldTriggerReview: 阈值/关闭/缺 skill_manage', () => {
  expect(shouldTriggerReview(10, 10, ['skill_manage'])).toBe(true);
  expect(shouldTriggerReview(9, 10, ['skill_manage'])).toBe(false);
  expect(shouldTriggerReview(99, 0, ['skill_manage'])).toBe(false); // 0=关闭
  expect(shouldTriggerReview(10, 10, ['skill_view'])).toBe(false);   // 无 skill_manage
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run skill-review`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

新建 `packages/agent/src/skill-review.ts`：
```ts
import { v4 as uuid } from 'uuid';
import type { Message } from '@hermes/core';
import type { Provider, CompletionChunk } from '@hermes/providers';
import type { ToolRegistry, ToolContext } from '@hermes/tools';

export interface ReviewDeps {
  provider: Provider;
  registry: ToolRegistry;
  model: string;
  maxIterations?: number; // 默认 16
}

export interface ReviewSummary {
  actions: string[];   // 成功的 skill_manage 结果串
  iterations: number;  // 实际跑的工具轮数
  error?: string;      // best-effort：内部异常记此，不外抛
}

const REVIEW_TOOLS = ['skill_view', 'skill_manage'];
const SUCCESS_PREFIXES = ['已创建', '已更新', '已 patch', '已删除'];

const REVIEW_PROMPT = `你是 Hermes 的技能库维护者。下面是一段刚结束的对话，请复盘并在必要时更新技能库（程序性知识）。

要主动——多数会话至少能产出一条小更新。出现以下任一信号就动手：
1. 用户纠正了你的风格/语气/做法 → 把该偏好写进相关技能；
2. 出现了非平凡的技巧/修复/绕法 → 记下供日后复用；
3. 某个已加载或相关技能已过时/缺失 → 立即修正。

优先级：先 patch 已有技能，其次新建“类级”技能（名字要泛化，能覆盖一类任务，不能是一次性任务名/PR 号/报错串）。
不要记录：环境瞬时错误、对工具的否定断言、一次性任务叙事。
用 skill_view 查看现有技能正文，用 skill_manage（create/edit/patch）写入。若确实没有值得保存的，直接回复“无需更新”，不要硬凑。`;

const REVIEW_INSTRUCTION = '复盘上面的对话并据此更新技能库（必要时先 skill_view 查看，再用 skill_manage 创建/编辑/patch）。没有值得保存的就回复“无需更新”。';

/** 后台技能自改进 review：独立工具循环，不持久化、不流式输出、只给技能工具。best-effort，绝不外抛。 */
export async function runSkillReview(
  deps: ReviewDeps,
  snapshot: Message[],
  ctx: ToolContext,
): Promise<ReviewSummary> {
  const max = deps.maxIterations ?? 16;
  const actions: string[] = [];
  let iterations = 0;
  try {
    const messages: Message[] = [
      { role: 'system', content: REVIEW_PROMPT },
      ...snapshot,
      { role: 'user', content: REVIEW_INSTRUCTION },
    ];
    const tools = deps.registry.getSchemas(REVIEW_TOOLS);
    for (let i = 0; i < max; i++) {
      if (ctx.signal?.aborted) break;
      const captured: CompletionChunk[] = [];
      // 消费流但丢弃 delta（后台不向用户输出）
      for await (const chunk of deps.provider.complete({ model: deps.model, messages, tools, signal: ctx.signal })) {
        captured.push(chunk);
      }
      const result = await deps.provider.aggregate((async function* () { for (const c of captured) yield c; })());
      // 严格按主循环构造 assistant 消息（工具关联所需）
      messages.push({
        role: 'assistant',
        content: result.content,
        toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
      });
      if (result.toolCalls.length === 0) break;
      iterations++;
      for (const call of result.toolCalls) {
        const output = await deps.registry.call(call.name, call.arguments, ctx);
        messages.push({ role: 'tool', content: output, toolCallId: call.id || uuid(), name: call.name });
        if (call.name === 'skill_manage' && SUCCESS_PREFIXES.some((p) => output.startsWith(p))) {
          actions.push(output);
        }
      }
    }
    return { actions, iterations };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.logger.warn(`技能自改进 review 失败:${msg}`);
    return { actions, iterations, error: msg };
  }
}

/** 是否触发自改进：阈值>0、本轮工具迭代数达标、skill_manage 在启用工具内。 */
export function shouldTriggerReview(iterations: number, interval: number, enabledTools: string[]): boolean {
  return interval > 0 && iterations >= interval && enabledTools.includes('skill_manage');
}
```

`packages/agent/src/index.ts` 末尾加：
```ts
export * from './skill-review.js';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run skill-review`
Expected: PASS（6 个用例）。

- [ ] **Step 5: 全量校验 + 提交**

```bash
pnpm -r exec tsc --noEmit
git add packages/agent/src/skill-review.ts packages/agent/src/skill-review.test.ts packages/agent/src/index.ts
git commit -m "$(printf 'feat(agent): runSkillReview 后台技能自改进 + shouldTriggerReview\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4：repl + main 接线（后台触发）

**Files:**
- Modify: `apps/cli/src/repl.ts`
- Modify: `apps/cli/src/main.ts`

> 说明：repl 是集成代码（readline + 后台 promise），不做单测；验收靠 tsc + 全量测试不回归 + 手测。可测逻辑（shouldTriggerReview / runSkillReview）已在 Task 3 覆盖。

- [ ] **Step 1: 改 `apps/cli/src/repl.ts`**

a. 顶部 import 增补：
```ts
import { runConversation, runSkillReview, shouldTriggerReview, type LoopDeps } from '@hermes/agent';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```
（`ApprovalGuard` / `ToolContext` 已 import；`pc` 已 import。）

b. `ReplOptions` 加字段：
```ts
export interface ReplOptions { approvalMode: 'manual' | 'off'; skillNudgeInterval: number }
```

c. 在 `guard` 构造之后、`rl.on('SIGINT'...)` 之前，加**独立的无 prompt review guard**（空 allowlist，绝不复用前台 `guard`）+ in-flight 跟踪 + 启用工具列表：
```ts
  // 后台自改进专用：无 prompt → confirm() 必拒 → skill_manage delete 被挡；独立空 allowlist 路径避免误用持久白名单
  const reviewGuard = new ApprovalGuard({
    mode: 'manual',
    allowlistPath: join(tmpdir(), 'hermes-review-noallow.json'),
    logger: ctx.logger,
  });
  const enabledTools = deps.toolNames ?? deps.registry.getToolNames();
  let inFlightReview: Promise<void> | null = null;
```

d. 把现有 turn 的 `try { for await ... } finally { process.off(...) }` 改成在循环里记录本轮 iterations，并在 finally 之后触发 review。具体：在 `try` 前加 `let turnIterations = -1;`；把 `turn_done` 分支改成顺带记录：
```ts
          case 'turn_done': {
            const u = ev.result.usage;
            stdout.write('\n');
            if (u) console.log(pc.dim(`[tokens ${u.promptTokens}+${u.completionTokens}]`));
            turnIterations = ev.iterations;
            break;
          }
```
在 `finally { process.off('SIGINT', onSig); }` **之后**加触发块：
```ts
    // 后台技能自改进：正常收尾(非中断)且达阈值且无 in-flight 才触发，不 await
    if (!controller.signal.aborted && turnIterations >= 0 && !inFlightReview
        && shouldTriggerReview(turnIterations, options.skillNudgeInterval, enabledTools)) {
      const snapshot = db.getMessages(session.id);
      const reviewCtx: ToolContext = { cwd: ctx.cwd, logger: ctx.logger, skills: deps.skills, approval: reviewGuard };
      inFlightReview = runSkillReview(
        { provider: deps.provider, registry: deps.registry, model: deps.model },
        snapshot, reviewCtx,
      )
        .then((sum) => { if (sum.actions.length) console.log(pc.dim(`\n💾 自改进:${sum.actions.join(' ')}`)); })
        .catch(() => { /* best-effort,不影响主流程 */ })
        .finally(() => { inFlightReview = null; });
    }
```
（`turnIterations` 需在每次 `for (;;)` 迭代的 try 之前声明/复位，确保每轮独立。）

e. `/exit` 与 `/new` 前 await in-flight，避免后台被打断/泄漏：
- `/exit` 分支：把 `if (line === '/exit') break;` 改为
```ts
    if (line === '/exit') { if (inFlightReview) await inFlightReview; break; }
```
- `/new` 分支开头(endSession 之前)加：`if (inFlightReview) await inFlightReview;`

- [ ] **Step 2: 改 `apps/cli/src/main.ts`**

把 repl 调用的第三参补上 `skillNudgeInterval`：
```ts
    await repl(deps, { cwd: process.cwd(), logger }, { approvalMode: config.approvalMode ?? 'manual', skillNudgeInterval: config.skillNudgeInterval });
```
（`config.skillNudgeInterval` 来自 Task 2。）

- [ ] **Step 3: 校验**

Run:
```bash
pnpm -r exec tsc --noEmit
npx vitest run
```
Expected: tsc 干净；全量测试通过（无回归，202 + Task1/2/3 新增）。

- [ ] **Step 4: 提交**

```bash
git add apps/cli/src/repl.ts apps/cli/src/main.ts
git commit -m "$(printf 'feat(cli): 后台技能自改进接线(阈值触发/独立 review guard/退出前 await)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 5：文档更新（README + ROADMAP）

**Files:**
- Modify: `README.md`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: 更新 README.md**

- 顶部「## 当前状态」标题：补 `+ 自改进 ✅`（与既有风格一致）。
- 阶段列表追加一行：`- 技能 c-1（自改进 review）✅ — 达阈值轮次后后台复盘会话、用 \`skill_manage\` 自动创建/精炼技能（不阻塞、禁删）`。
- 「## 技能 (Skills)」小节：把「后台技能自改进（self-improvement）与生命周期管家（curator）留待后续阶段（技能 c）」改为：
  - 新增一条：`后台自改进:某轮工具迭代数达阈值(默认 10,\`HERMES_SKILL_NUDGE_INTERVAL=0\` 关闭)后,回复发出即在后台复盘本会话,用 \`skill_manage\` 自动创建/精炼技能;后台禁删技能(无审批通道),成果下一轮系统提示即热更新可见。`
  - 把推迟项收窄为：`生命周期管家(curator)、provenance、技能支持文件留待后续阶段。`
- 「## 路线图」行：把 `技能 c（自改进 + curator，下一步）` 改为 `技能 c-1（自改进 review）✅ → 技能 c-余(curator + provenance + 支持文件，后续)`。
- 「## 已知限制」：把「后台自改进与 curator 生命周期管理仍未实现（技能 c，后续阶段）」改为「后台技能自改进已支持(技能 c-1);curator 生命周期管理、provenance、技能支持文件仍未实现(后续阶段)」。

- [ ] **Step 2: 更新 docs/ROADMAP.md**

- 阶段总览表：把 `技能 c | 自改进(后台 review fork)+ curator 生命周期管家 | ⏸️ 计划` 拆成：
```
| 技能 c-1 | 自改进 review(后台异步,达阈值复盘→skill_manage) | ✅ 完成 |
| 技能 c-余 | curator 生命周期 + provenance + 技能支持文件 | ⏸️ 计划 |
```
- 「### 技能 c：自改进 + curator ⏸️ 推迟」小节：改标题为 `### 技能 c-1：自改进 review ✅`，写「已做(MVP)」：
  - **runSkillReview**（`@hermes/agent/skill-review.ts`）：独立后台工具循环，复用 provider+registry，不持久化/不流式输出，只给 skill_view+skill_manage，喂 review 系统提示；best-effort（异常不外抛）；返回 actions/iterations。
  - **触发**：`turn_done` 暴露本轮工具迭代数；`shouldTriggerReview` 纯函数（阈值>0 且达标且 skill_manage 启用）；repl 在正常收尾后 fire-and-track，不阻塞，重叠跳过，`/exit`·`/new` 前 await。
  - **安全**：独立无 prompt + 空 allowlist 的 ApprovalGuard → 后台 `skill_manage delete` 必被挡（只增/精炼，不删）。
  - **config**：`skillNudgeInterval`（`HERMES_SKILL_NUDGE_INTERVAL`，默认 10，0=关）。
  - **热更新**：与主流程同一 SkillStore 实例，自改进成果下一轮系统提示即可见。
  - 再加一节 `### 技能 c-余 ⏸️ 推迟`：curator（active/stale/archived 自动归档/合并）、provenance（`.usage.json` agent_created）、技能支持文件（write_file/remove_file）、记忆自改进。
- 「## 跨阶段：已知限制」对应条目同步（technically 与 README 一致）。
- 「## 运维备忘」加一行：`后台自改进阈值 HERMES_SKILL_NUDGE_INTERVAL(默认 10,0=关);review 用独立无 prompt guard,禁删技能`。

- [ ] **Step 3: 提交**

```bash
git add README.md docs/ROADMAP.md
git commit -m "$(printf 'docs: 技能 c-1 自改进 review 完成,更新 README/ROADMAP\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## 完成后（控制者执行，非单任务）

- 派最终整体 code-review 子代理审 `main..HEAD` 全 diff（重点:后台并发安全、禁删保证、不污染主循环、热更新贯通、best-effort 不外抛）。
- 修掉阻塞项后用 superpowers:finishing-a-development-branch 收尾（用户惯例:按 1 = 合并 main + 推送 + 保留分支）。
- 提示用户用真实 GLM Key 手测：连续多轮工具操作(≥阈值)的会话后，观察是否出现 `💾 自改进:...` 且 `~/.hermes-ts/skills/` 多出/更新了技能；`HERMES_SKILL_NUDGE_INTERVAL=0` 时不触发。
