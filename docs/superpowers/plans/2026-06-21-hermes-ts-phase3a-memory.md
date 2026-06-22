# Hermes TS 阶段 3a:记忆系统(Memory) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 用 `memory` 工具把知识持久化到 `MEMORY.md`/`USER.md`,并每轮注入 system prompt,实现跨会话"记得"。

**Architecture:** `MemoryStore`(@hermes/core,与 SessionDB 并列的文件型存储)持有 MEMORY/USER 条目、字数上限、原子写、`render()`。`memory` 工具(@hermes/tools,新 memory toolset)经 `ToolContext.memory` 写;`buildSystemPrompt` 经 `LoopDeps.memory.render()` 读;CLI 创建唯一实例放进 deps 并每轮注入 ctx(沿用 approval 注入模式)。

**Tech Stack:** 沿用阶段 1/2(Node 20+ / TS strict / pnpm / Vitest / Zod / better-sqlite3)。无新增依赖。

**Spec:** `docs/superpowers/specs/2026-06-21-hermes-ts-phase3a-memory-design.md`

**前置状态:** 阶段 1/2/2.5 完成并合并。当前在 `phase3a-memory` 分支,基线已实测 **96 测试全绿**。内部包指向源码解析。工具用 `defineTool`,`registry.call` 捕获工具异常转错误字符串回灌。HERMES_HOME = `~/.hermes-ts`。

---

## 文件结构总览

| 文件 | 职责 |
|------|------|
| `packages/core/src/memory-store.ts`(新) | MemoryStore |
| `packages/core/src/memory-store.test.ts`(新) | MemoryStore 单测 |
| `packages/core/src/paths.ts`(改) | memoriesDir() |
| `packages/core/src/paths.test.ts`(改) | memoriesDir 测试 |
| `packages/core/src/index.ts`(改) | 导出 memory-store |
| `packages/tools/src/registry.ts`(改) | ToolContext 加 memory?: MemoryStore |
| `packages/tools/src/toolsets.ts`(改) | 加 memory toolset;core.includes 加 memory |
| `packages/tools/src/toolsets.test.ts`(改) | memory toolset 测试 |
| `packages/tools/src/builtin/memory.ts`(新) | memory 工具 |
| `packages/tools/src/builtin/memory.test.ts`(新) | memory 工具单测 |
| `packages/tools/src/builtin/index.ts`(改) | 注册 memory 工具 |
| `packages/agent/src/system-prompt.ts`(改) | buildSystemPrompt(cwd, memoryBlock?) |
| `packages/agent/src/system-prompt.test.ts`(新/改) | system prompt 测试 |
| `packages/agent/src/conversation-loop.ts`(改) | LoopDeps.memory? + 注入 render() |
| `packages/agent/src/conversation-loop.test.ts`(改) | 记忆注入测试 |
| `apps/cli/src/main.ts`(改) | 创建 MemoryStore 放进 deps |
| `apps/cli/src/repl.ts`(改) | 每轮注入 ctx.memory |

---

## Task 1:MemoryStore

**Files:**
- Create: `packages/core/src/memory-store.ts`, `packages/core/src/memory-store.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: 写失败测试**

`packages/core/src/memory-store.test.ts`:
```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './memory-store.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hermes-mem-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('add 追加条目并落盘', () => {
  const m = new MemoryStore(dir);
  m.add('memory', '喜欢用 pnpm');
  expect(m.getEntries('memory')).toEqual(['喜欢用 pnpm']);
  expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('喜欢用 pnpm');
});

test('add 多条用 § 分隔落盘', () => {
  const m = new MemoryStore(dir);
  m.add('memory', 'a');
  m.add('memory', 'b');
  expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('a\n§\nb');
});

test('user target 写 USER.md', () => {
  const m = new MemoryStore(dir);
  m.add('user', '用户叫 Danovan');
  expect(readFileSync(join(dir, 'USER.md'), 'utf8')).toBe('用户叫 Danovan');
});

test('render 含条目;空 store render 为空', () => {
  const m = new MemoryStore(dir);
  expect(m.render()).toBe('');
  m.add('memory', 'foo');
  expect(m.render()).toContain('foo');
  expect(m.render()).toContain('MEMORY');
});

test('新 MemoryStore 从同目录加载条目(持久化)', () => {
  new MemoryStore(dir).add('memory', 'persisted');
  const m2 = new MemoryStore(dir);
  expect(m2.getEntries('memory')).toEqual(['persisted']);
});

test('add 超字数上限 → throw 且不落盘', () => {
  const m = new MemoryStore(dir);
  m.add('user', 'x');
  const big = 'y'.repeat(1375);
  expect(() => m.add('user', big)).toThrow();
  // 不落盘:仍只有第一条
  expect(m.getEntries('user')).toEqual(['x']);
  expect(readFileSync(join(dir, 'USER.md'), 'utf8')).toBe('x');
});

test('replace 唯一替换', () => {
  const m = new MemoryStore(dir);
  m.add('memory', '喜欢 C#');
  m.replace('memory', 'C#', 'Rust');
  expect(m.getEntries('memory')).toEqual(['喜欢 Rust']);
});

test('replace 未找到 → throw', () => {
  const m = new MemoryStore(dir);
  m.add('memory', 'a');
  expect(() => m.replace('memory', 'zzz', 'b')).toThrow();
});

test('replace 多匹配 → throw', () => {
  const m = new MemoryStore(dir);
  m.add('memory', 'foo one');
  m.add('memory', 'foo two');
  expect(() => m.replace('memory', 'foo', 'bar')).toThrow();
});

test('replace 含 $ 的替换按字面量', () => {
  const m = new MemoryStore(dir);
  m.add('memory', 'price TOKEN here');
  m.replace('memory', 'TOKEN', '$& $1');
  expect(m.getEntries('memory')).toEqual(['price $& $1 here']);
});

test('remove 删唯一条目', () => {
  const m = new MemoryStore(dir);
  m.add('memory', 'keep');
  m.add('memory', 'delete-this');
  m.remove('memory', 'delete-this');
  expect(m.getEntries('memory')).toEqual(['keep']);
});

test('remove 未找到 → throw', () => {
  const m = new MemoryStore(dir);
  m.add('memory', 'a');
  expect(() => m.remove('memory', 'zzz')).toThrow();
});

test('损坏/缺失文件 → 空条目不崩', () => {
  // 不写任何文件
  expect(() => new MemoryStore(dir)).not.toThrow();
  expect(new MemoryStore(dir).getEntries('memory')).toEqual([]);
  // 写一个目录占位让读出问题? 简单起见:空文件
  writeFileSync(join(dir, 'MEMORY.md'), '');
  expect(new MemoryStore(dir).getEntries('memory')).toEqual([]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/core/src/memory-store.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 memory-store.ts**

`packages/core/src/memory-store.ts`:
```ts
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type MemoryTarget = 'memory' | 'user';

const DELIM = '\n§\n';
const LIMITS: Record<MemoryTarget, number> = { memory: 2200, user: 1375 };
const FILES: Record<MemoryTarget, string> = { memory: 'MEMORY.md', user: 'USER.md' };
const TITLES: Record<MemoryTarget, string> = {
  memory: 'MEMORY(你的长期笔记)',
  user: 'USER(用户画像)',
};

export class MemoryStore {
  private readonly dir: string;
  private readonly entries: Record<MemoryTarget, string[]>;

  constructor(dir: string) {
    this.dir = dir;
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    this.entries = {
      memory: this.load('memory'),
      user: this.load('user'),
    };
  }

  getEntries(target: MemoryTarget): string[] {
    return [...this.entries[target]];
  }

  add(target: MemoryTarget, content: string): void {
    const c = content.trim();
    if (!c) throw new Error('记忆内容不能为空。');
    const next = [...this.entries[target], c];
    this.commit(target, next);
  }

  replace(target: MemoryTarget, oldText: string, content: string): void {
    const idx = this.uniqueIndex(target, oldText);
    const updated = this.entries[target][idx]!.split(oldText).join(content);
    const next = [...this.entries[target]];
    next[idx] = updated;
    this.commit(target, next);
  }

  remove(target: MemoryTarget, oldText: string): void {
    const idx = this.uniqueIndex(target, oldText);
    const next = this.entries[target].filter((_, i) => i !== idx);
    this.commit(target, next);
  }

  render(): string {
    const blocks: string[] = [];
    for (const target of ['memory', 'user'] as MemoryTarget[]) {
      const entries = this.entries[target];
      if (entries.length === 0) continue;
      const body = entries.join(DELIM);
      blocks.push(`════ ${TITLES[target]} [${body.length}/${LIMITS[target]}] ════\n${body}`);
    }
    return blocks.join('\n\n');
  }

  private uniqueIndex(target: MemoryTarget, oldText: string): number {
    const matches = this.entries[target]
      .map((e, i) => (e.includes(oldText) ? i : -1))
      .filter((i) => i !== -1);
    if (matches.length === 0) throw new Error(`未找到包含 "${oldText}" 的记忆条目。`);
    if (matches.length > 1) throw new Error(`"${oldText}" 命中多条记忆,请提供更长的上下文使其唯一。`);
    return matches[0]!;
  }

  // 校验上限(超限抛错,不改内存、不落盘)→ 通过则更新内存 + 原子写
  private commit(target: MemoryTarget, next: string[]): void {
    const joined = next.join(DELIM);
    if (joined.length > LIMITS[target]) {
      throw new Error(
        `${FILES[target]} 超出 ${LIMITS[target]} 字上限(将达 ${joined.length})。请先用 remove 删除过时条目。当前条目:\n${this.entries[target].map((e, i) => `[${i}] ${e}`).join('\n')}`,
      );
    }
    this.writeAtomic(target, joined);
    this.entries[target] = next;
  }

  private load(target: MemoryTarget): string[] {
    try {
      const raw = readFileSync(join(this.dir, FILES[target]), 'utf8');
      if (raw.trim() === '') return [];
      return raw.split(DELIM);
    } catch {
      return [];
    }
  }

  private writeAtomic(target: MemoryTarget, content: string): void {
    const path = join(this.dir, FILES[target]);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/core/src/memory-store.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: 导出 + 提交**

在 `packages/core/src/index.ts` 追加:`export * from './memory-store.js';`
Run: `pnpm --filter @hermes/core exec tsc --noEmit`(干净)
Run: `pnpm vitest run`(96 + ~13 = ~109)
```bash
git add -A
git commit -m "feat(core): MemoryStore(MEMORY/USER 条目 + 字数上限 + 原子写 + render)"
```

---

## Task 2:paths.memoriesDir

**Files:**
- Modify: `packages/core/src/paths.ts`, `packages/core/src/paths.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/paths.test.ts`:顶部 import 加 `memoriesDir`;追加:
```ts
test('memoriesDir 在 hermes home 下指向 memories', () => {
  expect(memoriesDir({ HOME: '/home/u' }).replace(/\\/g, '/')).toBe('/home/u/.hermes-ts/memories');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/core/src/paths.test.ts`

- [ ] **Step 3: 实现**

在 `packages/core/src/paths.ts` 追加:
```ts
export function memoriesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getHermesHome(env), 'memories');
}
```

- [ ] **Step 4: 运行确认通过 + 提交**

Run: `pnpm vitest run packages/core` (全绿)
Run: `pnpm --filter @hermes/core exec tsc --noEmit`(干净)
```bash
git add -A
git commit -m "feat(core): paths.memoriesDir"
```

---

## Task 3:ToolContext.memory + memory toolset

**Files:**
- Modify: `packages/tools/src/registry.ts`, `packages/tools/src/toolsets.ts`, `packages/tools/src/toolsets.test.ts`

- [ ] **Step 1: 给 toolsets 写失败测试**

在 `packages/tools/src/toolsets.test.ts` 追加:
```ts
test('memory toolset 存在且 core 包含它', () => {
  expect(Object.keys(TOOLSETS)).toContain('memory');
  expect(resolveToolset('memory')).toEqual(['memory']);
  expect(resolveToolset('core')).toContain('memory');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/tools/src/toolsets.test.ts`

- [ ] **Step 3: 改 toolsets.ts**

在 `TOOLSETS` 增加 memory 分组,并把 'memory' 加入 core.includes:
```ts
  memory: {
    description: '长期记忆读写',
    tools: ['memory'],
  },
  core: {
    description: '核心工具集',
    includes: ['file', 'terminal', 'memory'],
  },
```
(注意:把现有 `core.includes: ['file', 'terminal']` 改为加上 `'memory'`。)

- [ ] **Step 4: 给 ToolContext 加 memory 字段**

在 `packages/tools/src/registry.ts`:
- 顶部加 `import type { MemoryStore } from '@hermes/core';`(已有 `import type { ApprovalGuard } from './approval.js';`,并列)
- `ToolContext` 接口加:`memory?: MemoryStore;`

> 循环依赖检查:core 不依赖 tools,type-only import 安全(同 ApprovalGuard 模式)。

- [ ] **Step 5: 运行确认通过 + 提交**

Run: `pnpm vitest run packages/tools/src/toolsets.test.ts`(含新测试)
Run: `pnpm --filter @hermes/tools exec tsc --noEmit`(干净)
Run: `pnpm vitest run`(全绿)
```bash
git add -A
git commit -m "feat(tools): memory toolset + ToolContext.memory"
```

---

## Task 4:memory 工具

**Files:**
- Create: `packages/tools/src/builtin/memory.ts`, `packages/tools/src/builtin/memory.test.ts`
- Modify: `packages/tools/src/builtin/index.ts`

- [ ] **Step 1: 写失败测试**

`packages/tools/src/builtin/memory.test.ts`:
```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, createLogger } from '@hermes/core';
import { memoryTool } from './memory.js';

let dir: string;
let mem: MemoryStore;
const ctx = () => ({ cwd: process.cwd(), logger: createLogger('test'), memory: mem });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hermes-memtool-')); mem = new MemoryStore(dir); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('add 经工具落盘', async () => {
  const out = await memoryTool.handler({ action: 'add', target: 'memory', content: '喜欢 pnpm' }, ctx());
  expect(mem.getEntries('memory')).toEqual(['喜欢 pnpm']);
  expect(out).toContain('memory');
});

test('add 缺 content → 错误', async () => {
  await expect(memoryTool.handler({ action: 'add', target: 'memory' }, ctx())).rejects.toThrow();
});

test('replace 经工具', async () => {
  mem.add('user', '喜欢 C#');
  await memoryTool.handler({ action: 'replace', target: 'user', oldText: 'C#', content: 'Rust' }, ctx());
  expect(mem.getEntries('user')).toEqual(['喜欢 Rust']);
});

test('replace 缺 oldText → 错误', async () => {
  await expect(memoryTool.handler({ action: 'replace', target: 'user', content: 'x' }, ctx())).rejects.toThrow();
});

test('remove 经工具', async () => {
  mem.add('memory', 'old fact');
  await memoryTool.handler({ action: 'remove', target: 'memory', oldText: 'old fact' }, ctx());
  expect(mem.getEntries('memory')).toEqual([]);
});

test('无 ctx.memory → 返回不可用字符串(不抛)', async () => {
  const out = await memoryTool.handler(
    { action: 'add', target: 'memory', content: 'x' },
    { cwd: process.cwd(), logger: createLogger('test') },
  );
  expect(out).toContain('不可用');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/tools/src/builtin/memory.test.ts`

- [ ] **Step 3: 实现 memory.ts**

`packages/tools/src/builtin/memory.ts`:
```ts
import { z } from 'zod';
import { defineTool } from '../registry.js';

export const memoryTool = defineTool({
  name: 'memory',
  description:
    '保存/更新长期记忆。WHEN:用户表达偏好、纠正、个人信息,或你学到关于其环境/约定/工作流的稳定事实时主动保存。优先级:用户偏好&纠正 > 环境事实 > 流程。target=memory 存你的笔记,user 存用户画像。',
  toolset: 'memory',
  schema: z.object({
    action: z.enum(['add', 'replace', 'remove']),
    target: z.enum(['memory', 'user']),
    content: z.string().optional().describe('add/replace 的内容'),
    oldText: z.string().optional().describe('replace/remove 定位用的子串'),
  }),
  handler: async ({ action, target, content, oldText }, ctx) => {
    if (!ctx.memory) return '记忆系统不可用。';
    if (action === 'add') {
      if (content === undefined) throw new Error('add 需要 content 参数。');
      ctx.memory.add(target, content);
      return `已向 ${target} 添加 1 条记忆。`;
    }
    if (action === 'replace') {
      if (oldText === undefined || content === undefined) {
        throw new Error('replace 需要 oldText 与 content 参数。');
      }
      ctx.memory.replace(target, oldText, content);
      return `已更新 ${target} 中的记忆。`;
    }
    // remove
    if (oldText === undefined) throw new Error('remove 需要 oldText 参数。');
    ctx.memory.remove(target, oldText);
    return `已从 ${target} 删除 1 条记忆。`;
  },
});
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/tools/src/builtin/memory.test.ts`
Expected: PASS（6）

- [ ] **Step 5: 注册 memory 工具**

修改 `packages/tools/src/builtin/index.ts`:import `memoryTool`,加入 `builtinTools` 数组,并在 `registerBuiltins` 加 `registry.register(memoryTool);`(沿用逐个注册写法)。

- [ ] **Step 6: 全量 + typecheck + 提交**

Run: `pnpm vitest run`(全绿)
Run: `pnpm --filter @hermes/tools exec tsc --noEmit`(干净)
```bash
git add -A
git commit -m "feat(tools): memory 工具(add/replace/remove)+ 注册"
```

---

## Task 5:系统提示注入

**Files:**
- Modify: `packages/agent/src/system-prompt.ts`
- Create/Modify: `packages/agent/src/system-prompt.test.ts`
- Modify: `packages/agent/src/conversation-loop.ts`, `packages/agent/src/conversation-loop.test.ts`

- [ ] **Step 1: 写 system-prompt 失败测试**

`packages/agent/src/system-prompt.test.ts`(若不存在则新建):
```ts
import { test, expect } from 'vitest';
import { buildSystemPrompt } from './system-prompt.js';

test('buildSystemPrompt 含 cwd', () => {
  expect(buildSystemPrompt('/work')).toContain('/work');
});

test('buildSystemPrompt 带 memoryBlock 时包含它', () => {
  const out = buildSystemPrompt('/work', '════ MEMORY ════\n喜欢 pnpm');
  expect(out).toContain('喜欢 pnpm');
});

test('buildSystemPrompt 不带 memoryBlock 时不含记忆标记', () => {
  expect(buildSystemPrompt('/work')).not.toContain('MEMORY');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/agent/src/system-prompt.test.ts`
(若 buildSystemPrompt 当前不接第二参,带 memoryBlock 的测试会失败)

- [ ] **Step 3: 改 system-prompt.ts**

READ 现有 `packages/agent/src/system-prompt.ts`。把签名改为:
```ts
export function buildSystemPrompt(cwd: string, memoryBlock?: string): string {
  const parts = [ /* ...现有身份/时间/cwd/工具说明各行... */ ];
  if (memoryBlock && memoryBlock.trim() !== '') {
    parts.push('', '以下是你的长期记忆(跨会话持久):', memoryBlock);
  }
  return parts.join('\n');
}
```
(保留现有内容行,只在末尾追加 memoryBlock 段。)

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/agent/src/system-prompt.test.ts`

- [ ] **Step 5: 写 conversation-loop 失败测试**

在 `packages/agent/src/conversation-loop.test.ts` 追加(复用 scriptedProvider/makeDeps;需要捕获 provider 收到的 messages):
```ts
test('注入 deps.memory 后 system 消息含记忆内容', async () => {
  const seen: import('@hermes/core').Message[][] = [];
  const provider: Provider = {
    name: 'mock',
    async *complete(req) { seen.push(req.messages); yield { contentDelta: 'ok' }; },
    async aggregate(): Promise<CompletionResult> { return { content: 'ok', toolCalls: [], finishReason: 'stop' }; },
  };
  const { db, deps } = makeDeps(provider);
  // 用一个最小的 memory-like 对象(只需 render())注入
  const fakeMemory = { render: () => '════ MEMORY ════\n记得喜欢 pnpm' } as unknown as import('@hermes/core').MemoryStore;
  const filtered = { ...deps, memory: fakeMemory };
  const s = db.createSession();
  for await (const _ of runConversation(filtered, s.id, 'hi', { cwd: '/', logger: createLogger('t') })) { /* drain */ }
  const sys = seen[0]!.find((m) => m.role === 'system');
  expect(sys?.content).toContain('记得喜欢 pnpm');
});
```
（注:用 `{ ...deps, memory }` 构造,因为 makeDeps 返回 inferred 字面量,不能直接赋 memory。fakeMemory 用 `as unknown as MemoryStore` 仅取 render()。`Message`/`MemoryStore` 用内联 import 类型;若测试文件顶部已 import Provider/CompletionResult/createLogger 则复用。)

- [ ] **Step 6: 运行确认失败**

Run: `pnpm vitest run packages/agent/src/conversation-loop.test.ts`
Expected: FAIL（loop 还没把 memory 注入 system prompt;且 LoopDeps 无 memory → tsc 报错,但 vitest esbuild 仍运行,断言失败为红)

- [ ] **Step 7: 改 conversation-loop.ts**

- `LoopDeps` 接口加:`memory?: import('@hermes/core').MemoryStore;`(或在顶部 `import type { MemoryStore } from '@hermes/core'` 后用 `memory?: MemoryStore;`——优先后者,顶部加 type import)
- 找到构建 system 消息处 `buildSystemPrompt(ctx.cwd)`,改为 `buildSystemPrompt(ctx.cwd, deps.memory?.render())`。
- 保留现有 ASCII 注释与所有逻辑。

- [ ] **Step 8: 运行确认通过 + 全量 + 提交**

Run: `pnpm vitest run packages/agent`(全绿)
Run: `pnpm vitest run`(全绿)
Run: `pnpm --filter @hermes/agent exec tsc --noEmit`(干净)
```bash
git add -A
git commit -m "feat(agent): system prompt 注入记忆 + LoopDeps.memory"
```

---

## Task 6:CLI 接线

**Files:**
- Modify: `apps/cli/src/main.ts`, `apps/cli/src/repl.ts`

- [ ] **Step 1: 改 main.ts**

READ `apps/cli/src/main.ts`。
- import:`MemoryStore, memoriesDir` from `@hermes/core`(加到现有 core import)。
- 在 `ensureHermesHome()` 之后创建 store:
```ts
  const memory = new MemoryStore(memoriesDir());
```
- 把 `memory` 加进 `deps` 对象:`const deps = { db, provider, registry, model: config.model, maxIterations: config.maxIterations, toolNames, memory };`

- [ ] **Step 2: 改 repl.ts**

READ `apps/cli/src/repl.ts`。找到每轮 `runConversation(deps, session.id, line, { ...ctx, signal: controller.signal, approval: guard })`,加上 `memory: deps.memory`:
```ts
runConversation(deps, session.id, line, { ...ctx, signal: controller.signal, approval: guard, memory: deps.memory })
```

- [ ] **Step 3: typecheck + 冒烟 + 全量 + 提交**

Run: `pnpm --filter @hermes/cli exec tsc --noEmit`(干净)
Run: `GLM_API_KEY= pnpm --filter @hermes/cli exec tsx src/main.ts`(打印缺 key 并退出 1,不挂起)
Run: `pnpm vitest run`(全绿)
```bash
git add -A
git commit -m "feat(cli): 创建 MemoryStore 并注入对话上下文"
```

---

## Task 7:端到端验证 + README/ROADMAP

**Files:**
- Modify: `README.md`, `docs/ROADMAP.md`

- [ ] **Step 1: 全量 typecheck + 测试**

Run: `pnpm -r exec tsc --noEmit`(全包干净)
Run: `pnpm vitest run`(全绿)

- [ ] **Step 2: 手动验证记忆(无需 API key)**

写临时脚本(或 node --import tsx -e;不行则 `apps/cli/src/_smoke_p3a.ts` 跑后删):
```ts
import { MemoryStore } from '@hermes/core';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const d = mkdtempSync(join(tmpdir(), 'smoke-mem-'));
const m = new MemoryStore(d);
m.add('memory', '喜欢用 pnpm'); m.add('user', '用户叫 Danovan');
console.log('render:\n' + m.render());
const m2 = new MemoryStore(d);
console.log('reload memory entries:', JSON.stringify(m2.getEntries('memory')));
```
Expected:render 含两块(MEMORY/USER);reload 后条目仍在。报告输出,删除临时文件。

- [ ] **Step 3: 更新 README.md**

READ README。
- `@hermes/tools` 描述补「+ 记忆工具(memory)」;工具列表加 `memory`。
- 新增「记忆 (Memory)」小节:MEMORY.md/USER.md 持久化在 `~/.hermes-ts/memories/`;模型用 `memory` 工具(add/replace/remove)主动记;字数上限 2200/1375;每轮注入 system prompt 实现跨会话记忆。
- 「已知限制」:把「无...记忆与技能」改为「无技能系统;跨会话记忆已支持但无 session 全文搜索(阶段 3b)」之类。

- [ ] **Step 4: 更新 docs/ROADMAP.md**

READ ROADMAP。
- 阶段总览表:把「3 记忆+技能」一行拆/改为「3a 记忆 ✅」+「3b session_search ⏸️」(或在该行标注 3a 完成)。
- 阶段 3 小节:记忆部分标 ✅,列出已做(MemoryStore/memory 工具/系统提示注入/memory toolset),technical;session_search 与技能仍 ⏸️。
- 跨阶段「已知限制」:更新记忆相关条目。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "docs: 阶段3a README/ROADMAP 与端到端验证"
```

---

## 完成定义(阶段 3a DoD)

- [ ] 新测试全绿(memory-store ~13 + memory 工具 6 + toolsets 1 + system-prompt 3 + loop 1 = ~24 新),原 96 无回归
- [ ] `pnpm -r exec tsc --noEmit` 全包干净
- [ ] 手动:render 两块 + reload 持久化验证通过
- [ ] README + ROADMAP 更新(阶段 3a ✅)
- [ ] 全部提交到 git
