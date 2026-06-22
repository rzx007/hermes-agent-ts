# Hermes Agent TS — 阶段 2.5:命令审批 / 安全 设计

- **日期**: 2026-06-21
- **状态**: 设计阶段
- **源项目**: `D:/code/personal-project/hermes-agent`（tools/approval.py，~1900 行）
- **前置**: 阶段 1、2 已完成并合并。当前在 `phase2.5-command-approval` 分支,基线 71 测试全绿。

---

## 1. 背景与目标

阶段 1 的 `terminal` 工具直接执行任意 shell 命令,无任何防护(已知风险)。本阶段补上**危险命令审批**:命中危险模式的命令在执行前需用户审批,极致命的命令直接永久阻止。

保真度沿用「架构级对齐 + 惯用 TS 重写」。原项目 approval.py 是 1900 行的大模块(含 smart LLM 审批、gateway 异步队列、contextvar 并发隔离、execute_code 守卫等),本阶段只做**单进程 CLI 场景下的精简核心**。

---

## 2. 范围

### 2.1 做(MVP)
- **危险模式检测**:精选正则清单。两级:`HARDLINE`(永禁)+ `DANGEROUS`(需审批)。
- **交互审批**:命中 DANGEROUS → CLI 提示 `[o]nce / [s]ession / [a]lways / [d]eny`。
- **白名单**:精确命令串匹配。`session`(内存,本会话)+ `always`(持久化 `~/.hermes-ts/allowlist.json`)。
- **模式**:`manual`(默认,危险才提示)/ `off`(=`HERMES_YOLO_MODE`,放行 DANGEROUS,但 HARDLINE 仍拦)。
- **作用范围:仅 `terminal` 工具**。
- **架构**:审批经 `ToolContext.approval`(可选 `ApprovalGuard`)从工具传到 CLI(readline 提示)。

### 2.2 明确不做(推迟)
smart LLM 审批、gateway 异步审批队列 + contextvar 并发隔离、cron 专用路由、`execute_code` 守卫、文件写入(write_file/edit_file)审批、tirith 外部扫描、plugin hooks、`/approvals` 管理命令(YAGNI)。

### 2.3 向后兼容
`ToolContext.approval` 为可选。不注入 guard 时 `terminal` 照常执行——现有 71 测试不受影响,审批是 CLI 注入后才生效的能力。

---

## 3. 文件结构

```
packages/tools/
  src/
    approval.ts          (新) HARDLINE/DANGEROUS 模式 + detectDangerous + ApprovalGuard
    approval.test.ts     (新)
    registry.ts          (改) ToolContext 加 approval?: ApprovalGuard;导出从 index
    index.ts             (改) 导出 approval
    builtin/terminal.ts  (改) spawn 前调 ctx.approval?.check()
    builtin/terminal.test.ts (改) 补 guard 注入测试
packages/core/src/
    config.ts            (改) HermesConfig.approvalMode + loadConfig(HERMES_YOLO_MODE/HERMES_APPROVAL_MODE)
    config.test.ts       (改) 补 approvalMode 测试
    paths.ts             (改) allowlistPath()
apps/cli/src/
    repl.ts              (改) 构造 ApprovalGuard(prompt 接 readline)注入每轮 ctx.approval
    main.ts              (改) approvalMode 放进 deps
```
依赖方向不变。`approval.ts` 属 `@hermes/tools`,依赖 `@hermes/core` 的 Logger 类型。

---

## 4. 危险模式 + hardline（`approval.ts`）

正则均用 `i`(忽略大小写)标志。清单为精选(非穷尽),覆盖主要危险类别。

```ts
// 任何模式都阻止(连 off/yolo 都绕不过)
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
  [/\b(curl|wget)\b[^\n]*\|\s*(ba)?sh/i, '下载并执行'],
  [/\b(kill|pkill|killall)\b[^\n]*\b-9\b/i, '强制杀进程'],
  [/\bsystemctl\s+(stop|disable|mask)/i, '停用系统服务'],
  [/\bgit\b[^\n]*\bpush\b[^\n]*(--force|-f)\b/i, 'git 强推'],
  [/\b(tee\b[^\n]*|>>?\s*)\/etc\//i, '写 /etc'],
  [/\bsudo\b/i, 'sudo 提权'],
  [/>>?\s*~?\/?\.ssh\//i, '写 ~/.ssh'],
  [/\bshutdown\b|\breboot\b|\bhalt\b/i, '关机/重启'],
  [/\btruncate\b[^\n]*-s\s*0/i, '清空文件'],
];

export type DangerLevel = 'hardline' | 'dangerous' | 'safe';
export function detectDangerous(cmd: string): { level: DangerLevel; desc?: string };
// 先遍历 HARDLINE→hardline;再遍历 DANGEROUS→dangerous;否则 safe。返回首个命中的 desc。
```

> 清单精选而非穷尽:目标是拦住最常见的破坏性命令,而非做到形式化完备(原项目 47 条 + tirith 扫描)。后续可增补。

---

## 5. ApprovalGuard（状态 + 判定）

```ts
export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny';
export interface ApprovalRequest { command: string; description: string }

export interface ApprovalGuardOpts {
  mode: 'manual' | 'off';
  allowlistPath: string;
  prompt?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  logger?: Logger;
}

export class ApprovalGuard {
  private sessionAllow = new Set<string>();
  private persistentAllow: Set<string>;   // 从 allowlistPath 加载

  constructor(opts: ApprovalGuardOpts);   // 读 allowlist.json(失败→空集 + warn)

  async check(command: string): Promise<{ allowed: boolean; reason?: string }>;
}
```

### 5.1 check 判定层次（顺序严格）
1. `detectDangerous(command)`。
2. `hardline` → `{ allowed: false, reason: '已阻止(hardline):<desc>。此类命令永不允许执行。' }`（即使 mode=off）。
3. `safe` → `{ allowed: true }`。
4. 以下为 `dangerous`：
   - `mode === 'off'` → `{ allowed: true }`。
   - 命令在 `sessionAllow` 或 `persistentAllow`（精确串）→ `{ allowed: true }`。
   - `!prompt`（非交互且未预批）→ `{ allowed: false, reason: '...需要审批,但当前无交互审批通道。' }`（安全默认拒绝）。
   - 调 `prompt({command, description})` 取 decision：
     - `deny` → `{ allowed: false, reason: '用户拒绝执行该命令。' }`
     - `session` → 加入 `sessionAllow`，放行
     - `always` → 加入 `sessionAllow` + `persistentAllow`，`save()`，放行
     - `once` → 放行（不记录）

### 5.2 持久化
`allowlist.json` 格式：`{ "commands": string[] }`。`save()` 写整份。读失败/JSON 损坏 → 空集 + `logger?.warn`。写失败 → `logger?.warn`，本次仍放行（session 内有效）。

---

## 6. ToolContext + terminal 集成

`ToolContext` 增加可选字段：
```ts
export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  logger: Logger;
  approval?: ApprovalGuard;
}
```

`builtin/terminal.ts`：在 spawn **之前**加审批前置（其余 spawn/stdout/stderr/timeout/abort 逻辑不变）。

**实现形式（无歧义)**:把 handler 改成 `async`,先 `await` 审批检查,再 `return` 原来的 `new Promise`(执行体逐字不变,timeout/abort 逻辑完全不动)：
```ts
  handler: async ({ command, timeout = 120_000 }, ctx) => {
    if (ctx.approval) {
      const verdict = await ctx.approval.check(command);
      if (!verdict.allowed) return verdict.reason ?? '已阻止该命令。';
    }
    return new Promise<string>((resolve) => {
      // ... 原有 spawn / stdout / stderr / timeout / abort 逻辑,逐字不变 ...
    });
  },
```
> 不要把 async IIFE 放进 `new Promise` 执行体内部(那样 reject 会被吞)。check() 本身不抛错(见 §8),且只在通过后才进入 Promise。不通过 → 直接返回阻止字符串(经 registry 回灌模型,不执行、不抛)；无 guard → 跳过,行为同阶段 1。

---

## 7. CLI 接线 + config

### 7.1 config.ts
```ts
// HermesConfig 增加
approvalMode?: 'manual' | 'off';
// loadConfig:HERMES_YOLO_MODE 真值 → 'off';否则 HERMES_APPROVAL_MODE(manual|off)/yaml;默认 'manual'。
```
真值判断:`'1'|'true'|'yes'|'on'`(忽略大小写)。

### 7.2 paths.ts
```ts
export function allowlistPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getHermesHome(env), 'allowlist.json');
}
```

### 7.3 repl.ts 签名与接线
`repl` 增加**第三个参数** `options`,承载 CLI 级选项(避免污染 `@hermes/agent` 的 `LoopDeps`)：
```ts
export interface ReplOptions { approvalMode: 'manual' | 'off' }

export async function repl(
  deps: LoopDeps,
  ctx: Omit<ToolContext, 'signal'>,
  options: ReplOptions,
) {
  const { db } = deps;
  // ... 创建 rl ...
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
  // 每轮:runConversation(deps, session.id, line, { ...ctx, signal: controller.signal, approval: guard })
}
```
未识别/空输入 → `deny`（安全优先）。

### 7.4 main.ts
`main` 构造 `repl` 调用时传入第三个参数：
```ts
await repl(deps, { cwd: process.cwd(), logger }, { approvalMode: config.approvalMode ?? 'manual' });
```
**不**把 approvalMode 加进 `@hermes/agent` 的 `LoopDeps`(保持 agent 与审批解耦)。

> 设计要点:审批是 CLI 层关注点。agent 的 ConversationLoop 完全不知道审批存在——它只是把 `ctx`(可能含 approval)透传给 `registry.call` → 工具。职责清晰。`ReplOptions` 是 CLI 内部类型,审批模式经它从 main 流到 guard,不经过 agent 层。

---

## 8. 错误处理

| 情况 | 处理 |
|------|------|
| hardline 命中 | check 返回 not-allowed → terminal resolve 阻止字符串回灌模型(不执行/不抛) |
| dangerous + deny | "用户拒绝" 字符串回灌 |
| 非交互(无 prompt)+ dangerous + 未预批 | 拒绝 + 说明无审批通道 |
| allowlist.json 读失败/损坏 | 空白名单 + logger.warn |
| allowlist.json 写失败 | logger.warn,本次仍放行 |
| prompt 异常/空输入 | 当 `deny`(安全) |

原则:审批决定不抛错;拒绝 → 错误字符串回灌;文件 IO 失败降级 warn。

---

## 9. 测试（Vitest）

| 测试 | 覆盖 |
|------|------|
| `approval.test.ts` — detectDangerous | hardline(`rm -rf /`、`mkfs`、fork bomb、`dd of=/dev/sda`);dangerous(`rm -rf foo`、`chmod 777 x`、`curl ... \| sh`、`sudo apt`);safe(`ls`、`echo hi`、`git status`、`rm file.txt`) |
| `approval.test.ts` — ApprovalGuard.check | safe 放行;hardline 永禁(即使 mode='off');off 放行 dangerous;deny 阻止;once 放行不记录;session 放行且本会话再次免提示;always 放行 + 写 allowlist;无 prompt + dangerous → 拒绝 |
| `approval.test.ts` — 持久化 | always 写 allowlist.json;新 guard 从同文件加载后该命令免提示(临时 allowlistPath);读损坏文件 → 空集不崩 |
| `terminal.test.ts`(补) | 注入 mock guard(prompt→'deny')→ 危险命令返回阻止字符串且未执行;注入 guard(prompt→'always')→ 危险命令执行;safe 命令始终执行;不注入 guard → 行为不变(现有 4 测试) |
| `config.test.ts`(补) | HERMES_YOLO_MODE 真值 → approvalMode 'off';HERMES_APPROVAL_MODE='off' → 'off';默认 'manual' |

mock prompt 为确定性函数(返回固定 decision),无真实交互。文件测试用临时 `allowlistPath`(临时目录),不碰用户真实文件。

### 9.1 完成定义（DoD）
- 新测试全绿 + 原 71 无回归 + 全包 `tsc --noEmit` 干净
- 手动 `pnpm cli`:让模型执行 `rm -rf /tmp/test` → 出现审批提示;deny → 不执行;`HERMES_YOLO_MODE=1` 下 dangerous 直接跑但 `rm -rf /` 仍被 hardline 拦
- ROADMAP.md 阶段 2.5 标 ✅

---

## 10. 后续衔接点
- DANGEROUS/HARDLINE 清单可持续增补(精选→更全)
- 后续阶段可加:smart LLM 审批、文件写入审批、`/approvals` 管理命令、gateway 异步审批(网关阶段)、execute_code 守卫(代码执行阶段)
- 白名单粒度未来可扩展为前缀/glob(当前精确串)
