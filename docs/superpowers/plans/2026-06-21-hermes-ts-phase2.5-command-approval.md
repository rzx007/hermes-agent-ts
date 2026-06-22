# Hermes TS 阶段 2.5:命令审批 / 安全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `terminal` 工具加上命令审批——危险命令执行前需用户审批,极致命命令(hardline)永久阻止。

**Architecture:** 新模块 `@hermes/tools/approval.ts`:危险模式正则(HARDLINE 永禁 + DANGEROUS 需审批)+ `detectDangerous` + `ApprovalGuard`(会话/持久精确白名单 + check 判定 + readline prompt 回调)。`ToolContext` 加可选 `approval?`,terminal handler 改 async 先 await check 再执行。审批模式经 CLI `repl` 第三参数 `options` 注入,agent 层完全不感知审批。

**Tech Stack:** 沿用阶段 1/2(Node 20+ / TS strict / pnpm / Vitest / Zod / better-sqlite3)。无新增依赖。

**Spec:** `docs/superpowers/specs/2026-06-21-hermes-ts-phase2.5-command-approval-design.md`

**前置状态:** 阶段 1、2 完成并合并。当前在 `phase2.5-command-approval` 分支,基线已实测 **71 测试全绿**。内部包指向源码解析。工具用 `defineTool`,`registry.call` 捕获工具异常转错误字符串回灌。HERMES_HOME = `~/.hermes-ts`。

---

## 文件结构总览

| 文件 | 职责 |
|------|------|
| `packages/tools/src/approval.ts`(新) | HARDLINE/DANGEROUS 模式 + detectDangerous + ApprovalGuard |
| `packages/tools/src/approval.test.ts`(新) | approval 单测 |
| `packages/tools/src/registry.ts`(改) | ToolContext 加 `approval?: ApprovalGuard` |
| `packages/tools/src/index.ts`(改) | 导出 approval |
| `packages/tools/src/builtin/terminal.ts`(改) | handler 改 async,spawn 前 await ctx.approval?.check() |
| `packages/tools/src/builtin/terminal.test.ts`(改) | 补 guard 注入测试 |
| `packages/core/src/paths.ts`(改) | allowlistPath() |
| `packages/core/src/paths.test.ts`(改) | 补 allowlistPath 测试 |
| `packages/core/src/config.ts`(改) | HermesConfig.approvalMode + loadConfig |
| `packages/core/src/config.test.ts`(改) | 补 approvalMode 测试 |
| `apps/cli/src/repl.ts`(改) | repl 第三参 options + 构造 ApprovalGuard 注入 ctx.approval |
| `apps/cli/src/main.ts`(改) | repl 调用传 options |

---

## Task 1:危险模式 + detectDangerous

**Files:**
- Create: `packages/tools/src/approval.ts`
- Create: `packages/tools/src/approval.test.ts`

- [ ] **Step 1: 写失败测试**

`packages/tools/src/approval.test.ts`:
```ts
import { test, expect } from 'vitest';
import { detectDangerous } from './approval.js';

test('hardline:rm -rf / / mkfs / fork bomb / dd of=/dev', () => {
  expect(detectDangerous('rm -rf /').level).toBe('hardline');
  expect(detectDangerous('sudo mkfs.ext4 /dev/sda1').level).toBe('hardline');
  expect(detectDangerous(':(){ :|:& };:').level).toBe('hardline');
  expect(detectDangerous('dd if=/dev/zero of=/dev/sda').level).toBe('hardline');
});

test('dangerous:rm -r / chmod 777 / curl|sh / sudo', () => {
  expect(detectDangerous('rm -rf ./build').level).toBe('dangerous');
  expect(detectDangerous('chmod 777 file').level).toBe('dangerous');
  expect(detectDangerous('curl https://x.sh | sh').level).toBe('dangerous');
  expect(detectDangerous('sudo apt install foo').level).toBe('dangerous');
  expect(detectDangerous('git push --force').level).toBe('dangerous');
});

test('safe:ls / echo / git status / rm 单文件', () => {
  expect(detectDangerous('ls -la').level).toBe('safe');
  expect(detectDangerous('echo hello').level).toBe('safe');
  expect(detectDangerous('git status').level).toBe('safe');
  expect(detectDangerous('rm file.txt').level).toBe('safe');
});

test('命中返回描述', () => {
  const d = detectDangerous('rm -rf /');
  expect(d.desc).toBeTruthy();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/tools/src/approval.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 approval.ts(本任务只实现模式 + detectDangerous)**

`packages/tools/src/approval.ts`:
```ts
// 任何模式都阻止(连 off/yolo 都绕不过)——最致命的
const HARDLINE_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f?[a-z]*\s+\/(\s|$)/i, '递归删除根目录'],
  [/\bmkfs\b/i, '格式化文件系统'],
  [/\bdd\b[^\n]*\bof=\/dev\//i, 'dd 覆写块设备'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'fork bomb'],
  [/>\s*\/dev\/(sd|nvme|disk)/i, '写入块设备'],
];

// 命中即需审批(可被 off/yolo/白名单放行)
const DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-z]*\s+)*-[a-z]*r/i, '递归删除'],
  [/\bchmod\s+(-[a-z]*\s+)*(777|666|a\+w|o\+w)/i, '放开写权限'],
  [/\bchown\s+(-[a-z]*\s+)*-R\b/i, '递归改所有者'],
  [/\b(curl|wget)\b[^\n]*\|\s*(ba)?sh\b/i, '下载并执行'],
  [/\b(kill|pkill|killall)\b[^\n]*\b-9\b/i, '强制杀进程'],
  [/\bsystemctl\s+(stop|disable|mask)\b/i, '停用系统服务'],
  [/\bgit\b[^\n]*\bpush\b[^\n]*(--force|-f)\b/i, 'git 强推'],
  [/\b(tee\b[^\n]*|>>?\s*)\/etc\//i, '写 /etc'],
  [/\bsudo\b/i, 'sudo 提权'],
  [/>>?\s*~?\/?\.ssh\//i, '写 ~/.ssh'],
  [/\b(shutdown|reboot|halt)\b/i, '关机/重启'],
  [/\btruncate\b[^\n]*-s\s*0\b/i, '清空文件'],
];

export type DangerLevel = 'hardline' | 'dangerous' | 'safe';

export function detectDangerous(cmd: string): { level: DangerLevel; desc?: string } {
  for (const [re, desc] of HARDLINE_PATTERNS) {
    if (re.test(cmd)) return { level: 'hardline', desc };
  }
  for (const [re, desc] of DANGEROUS_PATTERNS) {
    if (re.test(cmd)) return { level: 'dangerous', desc };
  }
  return { level: 'safe' };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/tools/src/approval.test.ts`
Expected: PASS（4 个）

> 注意:`rm -rf /` 同时匹配 HARDLINE(根删除)与 DANGEROUS(递归删除),但 HARDLINE 先遍历 → 返回 hardline。`rm file.txt` 无 `-r` → safe。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(tools): 危险命令模式检测 detectDangerous(hardline/dangerous/safe)"
```

---

## Task 2:ApprovalGuard

**Files:**
- Modify: `packages/tools/src/approval.ts`
- Modify: `packages/tools/src/approval.test.ts`

- [ ] **Step 1: 追加失败测试**

在 `packages/tools/src/approval.test.ts` 追加(顶部 import 增加 `ApprovalGuard`、node fs/os/path):
```ts
import { ApprovalGuard } from './approval.js';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpAllowlist(): string {
  return join(mkdtempSync(join(tmpdir(), 'hermes-allow-')), 'allowlist.json');
}

test('safe 命令直接放行', async () => {
  const g = new ApprovalGuard({ mode: 'manual', allowlistPath: tmpAllowlist() });
  expect((await g.check('ls')).allowed).toBe(true);
});

test('hardline 永禁(即使 mode=off)', async () => {
  const g = new ApprovalGuard({ mode: 'off', allowlistPath: tmpAllowlist() });
  const v = await g.check('rm -rf /');
  expect(v.allowed).toBe(false);
  expect(v.reason).toContain('hardline');
});

test('off 放行 dangerous', async () => {
  const g = new ApprovalGuard({ mode: 'off', allowlistPath: tmpAllowlist() });
  expect((await g.check('rm -rf ./x')).allowed).toBe(true);
});

test('manual + 无 prompt + dangerous → 拒绝', async () => {
  const g = new ApprovalGuard({ mode: 'manual', allowlistPath: tmpAllowlist() });
  expect((await g.check('rm -rf ./x')).allowed).toBe(false);
});

test('deny 阻止;once 放行但不记忆', async () => {
  const path = tmpAllowlist();
  const g = new ApprovalGuard({ mode: 'manual', allowlistPath: path, prompt: async () => 'deny' });
  expect((await g.check('rm -rf ./x')).allowed).toBe(false);
  const g2 = new ApprovalGuard({ mode: 'manual', allowlistPath: path, prompt: async () => 'once' });
  expect((await g2.check('rm -rf ./x')).allowed).toBe(true);
  // once 不写文件
  expect(existsSync(path)).toBe(false);
});

test('session 放行且本会话再次免提示', async () => {
  let prompts = 0;
  const g = new ApprovalGuard({ mode: 'manual', allowlistPath: tmpAllowlist(), prompt: async () => { prompts++; return 'session'; } });
  expect((await g.check('rm -rf ./x')).allowed).toBe(true);
  expect((await g.check('rm -rf ./x')).allowed).toBe(true); // 第二次免提示
  expect(prompts).toBe(1);
});

test('always 放行且持久化,新 guard 加载后免提示', async () => {
  const path = tmpAllowlist();
  let prompts = 0;
  const g = new ApprovalGuard({ mode: 'manual', allowlistPath: path, prompt: async () => { prompts++; return 'always'; } });
  expect((await g.check('rm -rf ./keep')).allowed).toBe(true);
  expect(JSON.parse(readFileSync(path, 'utf8')).commands).toContain('rm -rf ./keep');
  // 新 guard 从同文件加载 → 免提示
  const g2 = new ApprovalGuard({ mode: 'manual', allowlistPath: path, prompt: async () => { prompts++; return 'deny'; } });
  expect((await g2.check('rm -rf ./keep')).allowed).toBe(true);
  expect(prompts).toBe(1); // g2 的 prompt 未被调用
});

test('损坏的 allowlist 文件 → 空集不崩', async () => {
  const path = tmpAllowlist();
  writeFileSync(path, '{ not json');
  expect(() => new ApprovalGuard({ mode: 'manual', allowlistPath: path })).not.toThrow();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/tools/src/approval.test.ts`
Expected: FAIL（ApprovalGuard 不存在）

- [ ] **Step 3: 实现 ApprovalGuard(追加到 approval.ts)**

在 `packages/tools/src/approval.ts` 追加:
```ts
import { readFileSync, writeFileSync } from 'node:fs';
import type { Logger } from '@hermes/core';

export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny';
export interface ApprovalRequest { command: string; description: string }

export interface ApprovalGuardOpts {
  mode: 'manual' | 'off';
  allowlistPath: string;
  prompt?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  logger?: Logger;
}

export class ApprovalGuard {
  private readonly mode: 'manual' | 'off';
  private readonly allowlistPath: string;
  private readonly prompt?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  private readonly logger?: Logger;
  private readonly sessionAllow = new Set<string>();
  private readonly persistentAllow: Set<string>;

  constructor(opts: ApprovalGuardOpts) {
    this.mode = opts.mode;
    this.allowlistPath = opts.allowlistPath;
    this.prompt = opts.prompt;
    this.logger = opts.logger;
    this.persistentAllow = this.load();
  }

  async check(command: string): Promise<{ allowed: boolean; reason?: string }> {
    const det = detectDangerous(command);
    if (det.level === 'hardline') {
      return { allowed: false, reason: `已阻止(hardline):${det.desc}。此类命令永不允许执行。` };
    }
    if (det.level === 'safe') return { allowed: true };
    // dangerous:
    if (this.mode === 'off') return { allowed: true };
    if (this.sessionAllow.has(command) || this.persistentAllow.has(command)) {
      return { allowed: true };
    }
    if (!this.prompt) {
      return { allowed: false, reason: `已阻止:危险命令(${det.desc})需要审批,但当前无交互审批通道。` };
    }
    let decision: ApprovalDecision;
    try {
      decision = await this.prompt({ command, description: det.desc! });
    } catch {
      decision = 'deny';
    }
    if (decision === 'deny') return { allowed: false, reason: '用户拒绝执行该命令。' };
    if (decision === 'session') this.sessionAllow.add(command);
    if (decision === 'always') {
      this.sessionAllow.add(command);
      this.persistentAllow.add(command);
      this.save();
    }
    return { allowed: true };
  }

  private load(): Set<string> {
    try {
      const raw = readFileSync(this.allowlistPath, 'utf8');
      const data = JSON.parse(raw) as { commands?: unknown };
      const cmds = Array.isArray(data.commands) ? data.commands.map(String) : [];
      return new Set(cmds);
    } catch {
      return new Set();
    }
  }

  private save(): void {
    try {
      writeFileSync(this.allowlistPath, JSON.stringify({ commands: [...this.persistentAllow] }, null, 2), 'utf8');
    } catch (e) {
      this.logger?.warn(`写 allowlist 失败:${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
```
> 注:`load()` 静默吞读错误(文件不存在/损坏 → 空集)。若想在损坏时 warn,需区分「不存在」与「损坏」——MVP 简单起见统一空集(测试只要求不崩)。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/tools/src/approval.test.ts`
Expected: PASS（4 + 8 = 12）

- [ ] **Step 5: 导出 + 提交**

在 `packages/tools/src/index.ts` 追加:
```ts
export * from './approval.js';
```
Run: `pnpm --filter @hermes/tools exec tsc --noEmit`（干净)
Run: `pnpm vitest run`（71 + 12 = 83）
```bash
git add -A
git commit -m "feat(tools): ApprovalGuard(判定 + 精确白名单 + 持久化)"
```

---

## Task 3:ToolContext.approval + terminal 集成

**Files:**
- Modify: `packages/tools/src/registry.ts`
- Modify: `packages/tools/src/builtin/terminal.ts`
- Modify: `packages/tools/src/builtin/terminal.test.ts`

- [ ] **Step 1: 给 ToolContext 加 approval 字段**

在 `packages/tools/src/registry.ts` 的 `ToolContext` 接口加(需 import 类型):
```ts
import type { ApprovalGuard } from './approval.js';
// ...
export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  logger: Logger;
  approval?: ApprovalGuard;
}
```
> 注意循环依赖:approval.ts import 了 registry.ts 吗?——不,approval.ts 不依赖 registry.ts(它只 import @hermes/core 的 Logger)。registry.ts import approval.ts 的 ApprovalGuard 类型(type-only import)。无运行时循环。若 tsc 报循环,改用 `import type`(已是 type)。

- [ ] **Step 2: 写失败测试(terminal + guard)**

在 `packages/tools/src/builtin/terminal.test.ts` 追加(复用现有 imports;增加 `ApprovalGuard` from '../approval.js',`mkdtempSync`/`tmpdir`/`join` 若未导入则加):
```ts
import { ApprovalGuard } from '../approval.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function denyGuard() {
  return new ApprovalGuard({ mode: 'manual', allowlistPath: join(mkdtempSync(join(tmpdir(), 'al-')), 'a.json'), prompt: async () => 'deny' });
}
function allowGuard() {
  return new ApprovalGuard({ mode: 'manual', allowlistPath: join(mkdtempSync(join(tmpdir(), 'al-')), 'a.json'), prompt: async () => 'once' });
}

test('注入 deny guard:危险命令被阻止且不执行', async () => {
  const out = await terminalTool.handler({ command: 'rm -rf ./should-not-run' }, { cwd: process.cwd(), logger: createLogger('t'), approval: denyGuard() });
  expect(out).toContain('拒绝');
});

test('注入 allow guard:危险命令放行执行', async () => {
  const out = await terminalTool.handler({ command: 'echo danger; rm -rf ./nonexistent-xyz' }, { cwd: process.cwd(), logger: createLogger('t'), approval: allowGuard() });
  expect(out).toContain('exit code');
});

test('注入 guard:safe 命令照常执行', async () => {
  const out = await terminalTool.handler({ command: 'echo safe' }, { cwd: process.cwd(), logger: createLogger('t'), approval: denyGuard() });
  expect(out).toContain('safe');
  expect(out).toContain('exit code: 0');
});
```
（注:`createLogger` 已在该测试文件导入;若没有,从 '@hermes/core' 加。现有 4 测试不传 approval,保持不变。)

- [ ] **Step 3: 运行确认失败**

Run: `pnpm vitest run packages/tools/src/builtin/terminal.test.ts`
Expected: FAIL（handler 还没做审批,危险命令仍执行 → "拒绝" 断言失败)

- [ ] **Step 4: 改 terminal.ts handler 为 async + 前置 check**

把 `packages/tools/src/builtin/terminal.ts` 的 handler 从:
```ts
  handler: ({ command, timeout = 120_000 }, ctx) =>
    new Promise<string>((resolve) => {
      const child = spawn('bash', ['-c', command], { cwd: ctx.cwd });
      // ... 原有逻辑 ...
    }),
```
改为:
```ts
  handler: async ({ command, timeout = 120_000 }, ctx) => {
    if (ctx.approval) {
      const verdict = await ctx.approval.check(command);
      if (!verdict.allowed) return verdict.reason ?? '已阻止该命令。';
    }
    return new Promise<string>((resolve) => {
      const child = spawn('bash', ['-c', command], { cwd: ctx.cwd });
      // ... 原有逻辑逐字不变 ...
    });
  },
```
**只**在外层包一层 async + check,`new Promise` 执行体逐字不动(spawn/stdout/stderr/timeout/abort)。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run packages/tools/src/builtin/terminal.test.ts`
Expected: PASS（原 4 + 新 3 = 7）

- [ ] **Step 6: typecheck + 全量 + 提交**

Run: `pnpm --filter @hermes/tools exec tsc --noEmit`（干净)
Run: `pnpm vitest run`（83 + 3 = 86）
```bash
git add -A
git commit -m "feat(tools): ToolContext.approval + terminal 执行前审批"
```

---

## Task 4:paths.allowlistPath + config.approvalMode

**Files:**
- Modify: `packages/core/src/paths.ts`, `packages/core/src/paths.test.ts`
- Modify: `packages/core/src/config.ts`, `packages/core/src/config.test.ts`

- [ ] **Step 1: 写失败测试(paths + config)**

在 `packages/core/src/paths.test.ts`:
(a) 把顶部 import 改为加上 `allowlistPath`:
```ts
import { getHermesHome, sessionDbPath, ensureHermesHome, allowlistPath } from './paths.js';
```
(b) 追加测试:
```ts
test('allowlistPath 在 hermes home 下指向 allowlist.json', () => {
  expect(allowlistPath({ HOME: '/home/u' }).replace(/\\/g, '/')).toBe('/home/u/.hermes-ts/allowlist.json');
});
```

在 `packages/core/src/config.test.ts` 追加(复用顶部 HOME() helper):
```ts
test('HERMES_YOLO_MODE 真值 → approvalMode off', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k', HERMES_YOLO_MODE: '1' } as NodeJS.ProcessEnv).approvalMode).toBe('off');
});
test('HERMES_APPROVAL_MODE=off → off', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k', HERMES_APPROVAL_MODE: 'off' } as NodeJS.ProcessEnv).approvalMode).toBe('off');
});
test('默认 approvalMode = manual', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k' } as NodeJS.ProcessEnv).approvalMode).toBe('manual');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/core`
Expected: FAIL

- [ ] **Step 3: 实现 paths.allowlistPath**

在 `packages/core/src/paths.ts` 追加:
```ts
export function allowlistPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getHermesHome(env), 'allowlist.json');
}
```

- [ ] **Step 4: 实现 config.approvalMode**

在 `HermesConfig` 接口加:
```ts
  approvalMode?: 'manual' | 'off';
```
在 `loadConfig` 加真值判断与解析(放在 return 前):
```ts
  const isTruthy = (v: string | undefined): boolean =>
    v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  const approvalMode: 'manual' | 'off' = isTruthy(env.HERMES_YOLO_MODE)
    ? 'off'
    : ((env.HERMES_APPROVAL_MODE ?? fromFile.approvalMode) === 'off' ? 'off' : 'manual');
```
在 return 对象加:`approvalMode,`

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run packages/core`
Expected: PASS（原 + 1 paths + 3 config = +4）

- [ ] **Step 6: typecheck + 全量 + 提交**

Run: `pnpm --filter @hermes/core exec tsc --noEmit`（干净)
Run: `pnpm vitest run`（86 + 4 = 90）
```bash
git add -A
git commit -m "feat(core): allowlistPath + config.approvalMode(YOLO/APPROVAL_MODE)"
```

---

## Task 5:CLI 接线(repl options + guard 注入)

**Files:**
- Modify: `apps/cli/src/repl.ts`
- Modify: `apps/cli/src/main.ts`

- [ ] **Step 1: 改 repl.ts 签名 + 构造 guard**

READ `apps/cli/src/repl.ts` 先。改动:
(a) 增加导出接口与第三参数:
```ts
import { ApprovalGuard } from '@hermes/tools';
import { allowlistPath } from '@hermes/core';

export interface ReplOptions { approvalMode: 'manual' | 'off' }

export async function repl(deps: LoopDeps, ctx: Omit<ToolContext, 'signal'>, options: ReplOptions) {
```
(b) 创建 rl 之后,构造 guard:
```ts
  const guard = new ApprovalGuard({
    mode: options.approvalMode,
    allowlistPath: allowlistPath(),
    logger: ctx.logger,
    prompt: async ({ command, description }) => {
      console.log(pc.yellow(`\n⚠️ 危险命令:${description}`));
      console.log(pc.dim(`    ${command}`));
      const ans = (await rl.question(pc.cyan('  [o]nce / [s]ession / [a]lways / [d]eny ▸ '))).trim().toLowerCase();
      return ans === 'a' ? 'always' : ans === 's' ? 'session' : ans === 'o' ? 'once' : 'deny';
    },
  });
```
(c) 每轮调用 runConversation 时把 guard 注入 ctx:找到现有的 `runConversation(deps, session.id, line, { ...ctx, signal: controller.signal })`,改为 `{ ...ctx, signal: controller.signal, approval: guard }`。

- [ ] **Step 2: 改 main.ts 传 options**

READ `apps/cli/src/main.ts`。找到 `await repl(deps, { cwd: process.cwd(), logger })`(或类似),改为:
```ts
  await repl(deps, { cwd: process.cwd(), logger }, { approvalMode: config.approvalMode ?? 'manual' });
```
（`logger` 变量在 Phase 2 已存在;`config.approvalMode` 来自 Task 4。)

- [ ] **Step 3: typecheck + 冒烟 + 全量 + 提交**

Run: `pnpm --filter @hermes/cli exec tsc --noEmit`（干净)
Run（无 key 冒烟,确认装配加载): `GLM_API_KEY= pnpm --filter @hermes/cli exec tsx src/main.ts`
Expected: 打印缺 key 并退出 1
Run: `pnpm vitest run`（90 仍全绿,CLI 无新单测)
```bash
git add -A
git commit -m "feat(cli): 注入 ApprovalGuard(readline 审批提示)+ approvalMode 接线"
```

---

## Task 6:端到端验证 + 文档更新

**Files:**
- Modify: `README.md`, `docs/ROADMAP.md`

- [ ] **Step 1: 全量类型检查 + 测试**

Run: `pnpm -r exec tsc --noEmit`（全包干净)
Run: `pnpm vitest run`（90 全绿)

- [ ] **Step 2: 手动验证审批(无需 API key)**

用临时脚本验证 guard 端到端(node --import tsx 不行就写 `apps/cli/src/_smoke_p25.ts` 跑后删除):
```bash
node --import tsx -e "import('@hermes/tools').then(async m=>{const g=new m.ApprovalGuard({mode:'manual',allowlistPath:'/tmp/al.json',prompt:async()=>'deny'});console.log('rm -rf /:',JSON.stringify(await g.check('rm -rf /')));console.log('rm -rf ./x:',JSON.stringify(await g.check('rm -rf ./x')));console.log('ls:',JSON.stringify(await g.check('ls')));});"
```
Expected:
- `rm -rf /` → allowed:false, reason 含 hardline
- `rm -rf ./x` → allowed:false(deny)
- `ls` → allowed:true

- [ ] **Step 3: 更新 README + ROADMAP**

`README.md`:
- `@hermes/tools` 描述补「命令审批(危险命令需确认)」
- 新增「命令审批」小节:`HERMES_APPROVAL_MODE`(manual/off)、`HERMES_YOLO_MODE`、hardline 永禁、`always` 写 `~/.hermes-ts/allowlist.json`
- 「已知限制」去掉「terminal 无命令审批」一条

`docs/ROADMAP.md`:阶段 2.5 状态改 ✅,并把「跨阶段已知限制」里 terminal 审批一条删除。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "docs: 阶段2.5 README/ROADMAP 与端到端验证"
```

---

## 完成定义(阶段 2.5 DoD)

- [ ] 新测试全绿(approval 12 + terminal 3 + paths 1 + config 3 = 19 新),原 71 无回归,共约 90
- [ ] `pnpm -r exec tsc --noEmit` 全包干净
- [ ] 手动验证:hardline 永禁、dangerous+deny 阻止、safe 放行
- [ ] README + ROADMAP 更新,阶段 2.5 标 ✅
- [ ] 全部提交到 git
