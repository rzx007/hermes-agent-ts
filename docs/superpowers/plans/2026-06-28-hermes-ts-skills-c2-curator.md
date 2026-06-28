# 技能 c-2：provenance + curator 归档 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给技能库加使用画像（`.usage.json`：谁建/用了几次/最近何时用），并在 CLI 启动时（及 `/curate`）自动把「agent 自建且久未使用」的技能归档到 `.archive/`——用户手建的技能永不自动归档。

**Architecture:** 三个新关注点各自独立成单元：`SkillUsage`（`.usage.json` 持久化）+ `SkillStore.archive`（移动+索引）+ `runCurator`（策略），都在 `@hermes/core`。provenance 经 `ctx.backgroundReview` 标记从工具/review 流入。CLI 在启动与 `/curate` 触发 curator。

**Tech Stack:** TypeScript(strict, NodeNext, noUncheckedIndexedAccess) · Vitest · node:fs。

**Spec:** `docs/superpowers/specs/2026-06-28-hermes-ts-skills-c2-curator-design.md`

**基线（开工前确认）:** `npx vitest run` 当前 212 通过、`pnpm -r exec tsc --noEmit` 干净（分支 `phase-skills-c2-curator`，已含 spec）。

---

## 重要约定（实现者必读）

- 内部包指向源码;从 `@hermes/*` 用 `import type` 引类型。`defineTool<T>` 定义工具,禁 `as`/`: ToolDef`。
- 跑测试:`npx vitest run <关键字>`(仓库根)。`pnpm --filter` 是 NO-OP。全量校验 `pnpm -r exec tsc --noEmit`。
- 提交中文 conventional-commits,body 末尾加 trailer:`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 关键设计:
  - **provenance 缺条目 = 用户建**(agentCreated 视为 false),curator 永不动。
  - `SkillUsage.create` = 身份事件(整条覆盖,重置 agentCreated/state/counts/timestamps);`record` = 变更(不动 agentCreated;缺条目则以 agentCreated=false 新建)。
  - curator 只归档 `agentCreated===true && state==='active' && 闲置>阈值`;坏时间戳→NaN→不归档。
  - 归档 = 移到 `~/.hermes-ts/skills/.archive/<dir>` + usage state=archived + 移出索引;扫描跳过 `.archive`。
  - review 写入的 agent 标记唯一在 `skill-review.ts` 的 `registry.call` 处注入(repl 的 reviewCtx 字面量不要设)。

---

## Task 1：SkillUsage（.usage.json 持久化）

**Files:**
- Create: `packages/core/src/skill-usage.ts`
- Modify: `packages/core/src/index.ts`（导出）
- Test: `packages/core/src/skill-usage.test.ts`

- [ ] **Step 1: 写失败测试** — 新建 `packages/core/src/skill-usage.test.ts`：
```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillUsage } from './skill-usage.js';

let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hermes-usage-')); path = join(dir, '.usage.json'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const T0 = new Date('2026-01-01T00:00:00Z');

test('create 新建条目(整条,active,counts 0)', () => {
  const u = new SkillUsage(path);
  u.create('a', { agentCreated: true, now: T0 });
  const e = u.get('a')!;
  expect(e.agentCreated).toBe(true);
  expect(e.state).toBe('active');
  expect(e.viewCount).toBe(0);
  expect(e.createdAt).toBe(T0.toISOString());
  expect(e.lastUsedAt).toBe(T0.toISOString());
});

test('create 覆盖旧条目(同名重建重置 provenance)', () => {
  const u = new SkillUsage(path);
  u.create('a', { agentCreated: true, now: T0 });
  u.record('a', { state: 'archived' });
  u.create('a', { agentCreated: false, now: T0 }); // 前台重建
  const e = u.get('a')!;
  expect(e.agentCreated).toBe(false);
  expect(e.state).toBe('active');
});

test('record view/patch 累加并更新 lastUsedAt;不动 agentCreated', () => {
  const u = new SkillUsage(path);
  u.create('a', { agentCreated: true, now: T0 });
  const T1 = new Date('2026-02-01T00:00:00Z');
  u.record('a', { view: true, now: T1 });
  u.record('a', { patch: true, now: T1 });
  const e = u.get('a')!;
  expect(e.viewCount).toBe(1);
  expect(e.patchCount).toBe(1);
  expect(e.lastUsedAt).toBe(T1.toISOString());
  expect(e.agentCreated).toBe(true);
});

test('record 缺条目 → 以 agentCreated=false 新建', () => {
  const u = new SkillUsage(path);
  u.record('legacy', { view: true, now: T0 });
  const e = u.get('legacy')!;
  expect(e.agentCreated).toBe(false);
  expect(e.viewCount).toBe(1);
});

test('remove 删除条目', () => {
  const u = new SkillUsage(path);
  u.create('a', { agentCreated: true, now: T0 });
  u.remove('a');
  expect(u.get('a')).toBeUndefined();
});

test('原子写后可重新加载', () => {
  const u = new SkillUsage(path);
  u.create('a', { agentCreated: true, now: T0 });
  const u2 = new SkillUsage(path);
  expect(u2.get('a')?.agentCreated).toBe(true);
});

test('坏 json 容错 → 空', () => {
  writeFileSync(path, '{ not json', 'utf8');
  const u = new SkillUsage(path);
  expect(u.entries()).toEqual([]);
});

test('缺文件 → 空,不崩', () => {
  const u = new SkillUsage(join(dir, 'nope', '.usage.json'));
  expect(u.entries()).toEqual([]);
});
```
Run `npx vitest run skill-usage` → FAIL（模块不存在）。

- [ ] **Step 2: 实现** — 新建 `packages/core/src/skill-usage.ts`：
```ts
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import type { Logger } from './logging.js';

export type SkillState = 'active' | 'archived';

export interface SkillUsageEntry {
  agentCreated: boolean;
  createdAt: string;   // ISO
  lastUsedAt: string;  // ISO
  viewCount: number;
  patchCount: number;
  state: SkillState;
}

/** 技能使用画像,持久化在 skillsDir/.usage.json。缺条目 = 用户建(agentCreated 视为 false)。 */
export class SkillUsage {
  private readonly path: string;
  private readonly logger?: Logger;
  private readonly map = new Map<string, SkillUsageEntry>();

  constructor(path: string, logger?: Logger) {
    this.path = path;
    this.logger = logger;
    try {
      const raw = readFileSync(path, 'utf8');
      const data: unknown = JSON.parse(raw);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [name, v] of Object.entries(data as Record<string, unknown>)) {
          if (v && typeof v === 'object') this.map.set(name, v as SkillUsageEntry);
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logger?.warn(`读取 .usage.json 失败,按空处理:${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  get(name: string): SkillUsageEntry | undefined { return this.map.get(name); }
  entries(): Array<[string, SkillUsageEntry]> { return [...this.map.entries()]; }

  /** 身份事件:整条覆盖(重置 agentCreated/state/counts/时间戳)。 */
  create(name: string, opts: { agentCreated: boolean; now?: Date }): void {
    const ts = (opts.now ?? new Date()).toISOString();
    this.map.set(name, {
      agentCreated: opts.agentCreated,
      createdAt: ts, lastUsedAt: ts,
      viewCount: 0, patchCount: 0, state: 'active',
    });
    this.save();
  }

  /** 变更事件:就地改;缺条目则以 agentCreated=false 新建。永不改 agentCreated。 */
  record(name: string, opts: { view?: boolean; patch?: boolean; state?: SkillState; now?: Date }): void {
    const ts = (opts.now ?? new Date()).toISOString();
    let e = this.map.get(name);
    if (!e) {
      e = { agentCreated: false, createdAt: ts, lastUsedAt: ts, viewCount: 0, patchCount: 0, state: 'active' };
      this.map.set(name, e);
    }
    if (opts.view) { e.viewCount++; e.lastUsedAt = ts; }
    if (opts.patch) { e.patchCount++; e.lastUsedAt = ts; }
    if (opts.state) { e.state = opts.state; }
    this.save();
  }

  remove(name: string): void {
    if (this.map.delete(name)) this.save();
  }

  private save(): void {
    const obj: Record<string, SkillUsageEntry> = {};
    for (const [k, v] of this.map) obj[k] = v;
    const tmp = `${this.path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
      renameSync(tmp, this.path);
    } catch (e) {
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      this.logger?.warn(`写 .usage.json 失败:${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
```
在 `packages/core/src/index.ts` 末尾加：`export * from './skill-usage.js';`

- [ ] **Step 3: 跑测试** `npx vitest run skill-usage` → PASS;`pnpm -r exec tsc --noEmit` → clean。
- [ ] **Step 4: 提交**
```bash
git add packages/core/src/skill-usage.ts packages/core/src/skill-usage.test.ts packages/core/src/index.ts
git commit -m "$(printf 'feat(core): SkillUsage(.usage.json provenance 存储)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2：SkillStore 集成 provenance

**Files:**
- Modify: `packages/core/src/skill-store.ts`
- Test: `packages/core/src/skill-store.test.ts`（已存在,追加）

- [ ] **Step 1: 写失败测试** — 追加到 `packages/core/src/skill-store.test.ts`（复用其共享 `dir` + `SKILL` 助手）：
```ts
test('create 记 provenance:前台默认 agentCreated=false', () => {
  const store = new SkillStore(dir);
  store.create('u1', SKILL('u1'));
  const e = store.usageEntries().find(([n]) => n === 'u1')?.[1];
  expect(e?.agentCreated).toBe(false);
  expect(e?.state).toBe('active');
});

test('create 透传 agentCreated=true', () => {
  const store = new SkillStore(dir);
  store.create('a1', SKILL('a1'), undefined, { agentCreated: true });
  expect(store.usageEntries().find(([n]) => n === 'a1')?.[1].agentCreated).toBe(true);
});

test('recordView 更新 lastUsedAt/viewCount(仅已知技能)', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'));
  store.recordView('a');
  expect(store.usageEntries().find(([n]) => n === 'a')?.[1].viewCount).toBe(1);
  store.recordView('nope'); // 未知,无副作用
  expect(store.usageEntries().some(([n]) => n === 'nope')).toBe(false);
});

test('patch 记一次 patch', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a', 'd', 'dup once'));
  store.patch('a', 'once', 'twice');
  expect(store.usageEntries().find(([n]) => n === 'a')?.[1].patchCount).toBe(1);
});

test('delete 同时移除 usage 条目', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'));
  store.delete('a');
  expect(store.usageEntries().some(([n]) => n === 'a')).toBe(false);
});
```
Run `npx vitest run skill-store` → 新增 FAIL（`usageEntries`/`recordView`/4th param 不存在）。

- [ ] **Step 2: 实现** — 改 `packages/core/src/skill-store.ts`：

a. 顶部 import 增补类型与 SkillUsage：
```ts
import { SkillUsage, type SkillUsageEntry } from './skill-usage.js';
```

b. 加字段并在构造函数最前面(在 `if (!existsSync(dir)) return;` 之前)初始化：
```ts
  private readonly dir: string;
  private readonly usage: SkillUsage;

  constructor(dir: string, logger?: Logger) {
    this.dir = dir;
    this.usage = new SkillUsage(join(dir, '.usage.json'), logger);
    if (!existsSync(dir)) return;
    // ... 其余扫描逻辑不变 ...
```

c. `create` 加可选第 4 参并记 provenance(身份事件用 `usage.create`)。把签名与 try 块改为：
```ts
  create(name: string, content: string, category?: string, opts?: { agentCreated?: boolean }): { path: string } {
    // ...前面校验逻辑不变...
    try {
      atomicWrite(file, content);
      const entry = this.parseSkill(this.dir, file);
      this.skills.push(entry);
      this.byName.set(entry.name, entry);
      this.usage.create(name, { agentCreated: opts?.agentCreated ?? false });
      return { path: file };
    } catch (e) {
      if (!dirExisted) { try { rmSync(skillDir, { recursive: true, force: true }); } catch { /* ignore */ } }
      throw e;
    }
  }
```

d. `edit` 在 `return` 前加：`this.usage.record(name, { patch: true });`
   `patch` 在 `return` 前加：`this.usage.record(name, { patch: true });`
   `delete` 在 `this.byName.delete(name);` 后加：`this.usage.remove(name);`

e. 新增两个方法(放在 `delete` 之后、`assertWithinRoot` 之前)：
```ts
  recordView(name: string): void {
    if (this.byName.has(name)) this.usage.record(name, { view: true });
  }

  usageEntries(): Array<[string, SkillUsageEntry]> {
    return this.usage.entries();
  }
```

- [ ] **Step 3: 跑测试** `npx vitest run skill-store` → PASS;`pnpm -r exec tsc --noEmit` → clean。
- [ ] **Step 4: 提交**
```bash
git add packages/core/src/skill-store.ts packages/core/src/skill-store.test.ts
git commit -m "$(printf 'feat(core): SkillStore 集成 provenance(create/edit/patch/delete/recordView/usageEntries)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3：SkillStore.archive() + 扫描跳过 .archive

**Files:**
- Modify: `packages/core/src/skill-store.ts`
- Test: `packages/core/src/skill-store.test.ts`

- [ ] **Step 1: 写失败测试** — 追加：
```ts
import { existsSync as fsExists } from 'node:fs'; // 若文件已 import existsSync 可复用,勿重复

test('archive 移到 .archive + 移出索引 + usage.state=archived', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'), undefined, { agentCreated: true });
  store.archive('a');
  expect(existsSync(join(dir, 'a'))).toBe(false);
  expect(existsSync(join(dir, '.archive', 'a', 'SKILL.md'))).toBe(true);
  expect(store.getContent('a')).toBeNull();
  expect(store.list().some((s) => s.name === 'a')).toBe(false);
  expect(store.usageEntries().find(([n]) => n === 'a')?.[1].state).toBe('archived');
});

test('归档后重扫不再加载(跳过 .archive)', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'), undefined, { agentCreated: true });
  store.archive('a');
  const store2 = new SkillStore(dir);
  expect(store2.getContent('a')).toBeNull();
  expect(store2.list().some((s) => s.name === 'a')).toBe(false);
});

test('archive 不存在的技能报错', () => {
  const store = new SkillStore(dir);
  expect(() => store.archive('nope')).toThrow(/不存在/);
});
```
（顶部 `existsSync` 应已在 Task 1 引入;若无则补 `existsSync` 到现有 node:fs import,勿重复声明。删掉上面那行 `fsExists` 占位注释。）
Run `npx vitest run skill-store` → 新增 FAIL（`archive` 不存在）。

- [ ] **Step 2: 实现** — 改 `packages/core/src/skill-store.ts`：

a. `findSkillFiles` 的跳过条件加 `.archive`：
```ts
        if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.archive') continue;
```

b. 新增 `archive`(放在 `delete` 之后)：
```ts
  archive(name: string): void {
    const existing = this.byName.get(name);
    if (!existing) throw new Error(`技能 "${name}" 不存在`);
    const skillDir = dirname(existing.file);
    const root = resolve(this.dir);
    const resolved = resolve(skillDir);
    if (resolved === root) throw new Error('拒绝归档技能根目录');
    if (!resolved.startsWith(root + sep)) throw new Error('拒绝归档技能根目录之外的路径');
    if (lstatSync(skillDir).isSymbolicLink()) throw new Error('拒绝归档 symlink/junction 链接目录');
    const archiveRoot = join(this.dir, '.archive');
    mkdirSync(archiveRoot, { recursive: true });
    const target = join(archiveRoot, basename(skillDir));
    rmSync(target, { recursive: true, force: true }); // 清掉同名旧归档(再次归档同名)
    renameSync(skillDir, target);
    this.usage.record(name, { state: 'archived' });
    const idx = this.skills.indexOf(existing);
    if (idx >= 0) this.skills.splice(idx, 1);
    this.byName.delete(name);
  }
```
（`mkdirSync`/`basename`/`renameSync`/`lstatSync`/`resolve`/`sep` 均已 import。）

- [ ] **Step 3: 跑测试** `npx vitest run skill-store` → PASS;`pnpm -r exec tsc --noEmit` → clean。
- [ ] **Step 4: 提交**
```bash
git add packages/core/src/skill-store.ts packages/core/src/skill-store.test.ts
git commit -m "$(printf 'feat(core): SkillStore.archive() + 扫描跳过 .archive\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4：runCurator 策略

**Files:**
- Create: `packages/core/src/skill-curator.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/skill-curator.test.ts`

- [ ] **Step 1: 写失败测试** — 新建 `packages/core/src/skill-curator.test.ts`：
```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillStore } from './skill-store.js';
import { runCurator } from './skill-curator.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hermes-cur-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const SKILL = (n: string) => `---\nname: ${n}\ndescription: d\n---\n\n正文`;
const NOW = new Date('2026-06-01T00:00:00Z');
const LONG_AGO = new Date('2026-01-01T00:00:00Z'); // 距 NOW ~151 天

test('归档 agent 建且久未用的技能', () => {
  const store = new SkillStore(dir);
  // 用注入的 now 让 create 的时间戳落在很久以前
  store.create('old', SKILL('old'), undefined, { agentCreated: true });
  // 直接通过 usage 把 lastUsedAt 调到很久以前(record state 不改时间;改用再次 create 注入 now)
  store.create('old', SKILL2 = SKILL('old')); // 见下方说明
});
```
> 注:`create` 不暴露 `now` 注入(SkillStore.create 内部用默认 now)。为可控测试,**用 SkillUsage 直接构造老条目**更干净。改用如下测试(直接操作 .usage.json 经 SkillUsage,再让 SkillStore 读取):

```ts
import { SkillUsage } from './skill-usage.js';

function seedAgentSkill(name: string, lastUsed: Date) {
  // 真建技能文件(让 archive 有目录可移)
  const s = new SkillStore(dir);
  s.create(name, SKILL(name), undefined, { agentCreated: true });
  // 覆盖该条目的时间戳为很久以前
  const u = new SkillUsage(join(dir, '.usage.json'));
  u.create(name, { agentCreated: true, now: lastUsed });
  return new SkillStore(dir); // 重新加载,带老时间戳
}

test('归档 agent 建且超阈值', () => {
  const store = seedAgentSkill('old', LONG_AGO);
  const rep = runCurator(store, { archiveAfterDays: 30, now: NOW });
  expect(rep.archived).toContain('old');
  expect(existsSync(join(dir, '.archive', 'old', 'SKILL.md'))).toBe(true);
});

test('用户建(agentCreated=false)永不归档', () => {
  const s = new SkillStore(dir);
  s.create('user', SKILL('user')); // 前台
  const u = new SkillUsage(join(dir, '.usage.json'));
  u.create('user', { agentCreated: false, now: LONG_AGO });
  const store = new SkillStore(dir);
  const rep = runCurator(store, { archiveAfterDays: 30, now: NOW });
  expect(rep.archived).toEqual([]);
});

test('active 未超阈值不归档', () => {
  const store = seedAgentSkill('fresh', new Date('2026-05-20T00:00:00Z')); // 距 NOW ~12 天
  const rep = runCurator(store, { archiveAfterDays: 30, now: NOW });
  expect(rep.archived).toEqual([]);
});

test('archiveAfterDays=0 关闭', () => {
  const store = seedAgentSkill('old', LONG_AGO);
  const rep = runCurator(store, { archiveAfterDays: 0, now: NOW });
  expect(rep.archived).toEqual([]);
  expect(rep.scanned).toBe(0);
});

test('坏时间戳条目 → NaN → 不归档', () => {
  const s = new SkillStore(dir);
  s.create('weird', SKILL('weird'), undefined, { agentCreated: true });
  const u = new SkillUsage(join(dir, '.usage.json'));
  // 手动塞坏时间戳
  u.record('weird', { state: 'active' });
  const entry = u.get('weird')!;
  entry.lastUsedAt = 'not-a-date'; entry.createdAt = 'not-a-date';
  u.create('weird', { agentCreated: true, now: NOW }); // 重写一条正常的以触发 save? 见下
  // 简化:直接断言坏时间戳不被归档——构造一条坏的并重载
  const u2 = new SkillUsage(join(dir, '.usage.json'));
  const e2 = u2.get('weird')!; e2.lastUsedAt = 'bad'; e2.createdAt = 'bad';
  u2.record('weird', {}); // 触发 save 持久化坏值
  const store = new SkillStore(dir);
  const rep = runCurator(store, { archiveAfterDays: 30, now: NOW });
  expect(rep.archived).toEqual([]);
});
```
> 实现者注:坏时间戳测试如上略繁琐,可简化为「直接 new SkillUsage、`create` 后手改 entry 字段为 'bad'、`record` 触发 save、重载 SkillStore 跑 curator 断言不归档」。核心断言:`runCurator` 对 `new Date('bad').getTime()===NaN` 的条目不归档。

Run `npx vitest run skill-curator` → FAIL（模块不存在）。

- [ ] **Step 2: 实现** — 新建 `packages/core/src/skill-curator.ts`：
```ts
import type { SkillStore } from './skill-store.js';
import type { Logger } from './logging.js';

export interface CuratorReport { scanned: number; archived: string[] }
export interface CuratorOpts { archiveAfterDays: number; now?: Date; logger?: Logger }

const DAY_MS = 86_400_000;

/** 自动归档 agent 自建且久未使用的技能。用户建技能永不归档。best-effort:单条失败跳过。 */
export function runCurator(skills: SkillStore, opts: CuratorOpts): CuratorReport {
  if (opts.archiveAfterDays <= 0) return { scanned: 0, archived: [] };
  const now = (opts.now ?? new Date()).getTime();
  const archived: string[] = [];
  let scanned = 0;
  for (const [name, entry] of skills.usageEntries()) {
    if (!entry.agentCreated || entry.state !== 'active') continue;
    scanned++;
    const last = new Date(entry.lastUsedAt ?? entry.createdAt).getTime();
    const idleDays = (now - last) / DAY_MS;
    if (idleDays > opts.archiveAfterDays) { // NaN > x 为 false → 坏时间戳不归档
      try { skills.archive(name); archived.push(name); }
      catch (e) { opts.logger?.warn(`归档技能 "${name}" 失败:${e instanceof Error ? e.message : String(e)}`); }
    }
  }
  return { scanned, archived };
}
```
在 `packages/core/src/index.ts` 末尾加：`export * from './skill-curator.js';`

- [ ] **Step 3: 跑测试** `npx vitest run skill-curator` → PASS;`pnpm -r exec tsc --noEmit` → clean。
- [ ] **Step 4: 提交**
```bash
git add packages/core/src/skill-curator.ts packages/core/src/skill-curator.test.ts packages/core/src/index.ts
git commit -m "$(printf 'feat(core): runCurator 自动归档久未用的 agent 建技能\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 5：provenance 接线（工具 + review）

**Files:**
- Modify: `packages/tools/src/registry.ts`（ToolContext 加 `backgroundReview?`）
- Modify: `packages/tools/src/builtin/skills.ts`（skill_view recordView;skill_manage create agentCreated）
- Modify: `packages/agent/src/skill-review.ts`（registry.call 注入 backgroundReview）
- Test: `packages/tools/src/builtin/skills.test.ts` + `packages/agent/src/skill-review.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

a. 追加到 `packages/tools/src/builtin/skills.test.ts`（复用其 `skills`/`ctxA`/`FM` 助手）：
```ts
test('skill_manage create 默认 agentCreated=false(前台)', async () => {
  await skillManageTool.handler({ action: 'create', name: 'fg', content: FM('fg') }, ctxA());
  expect(skills.usageEntries().find(([n]) => n === 'fg')?.[1].agentCreated).toBe(false);
});

test('skill_manage create 在 backgroundReview 下标 agentCreated=true', async () => {
  const ctx = { cwd: process.cwd(), logger: createLogger('test'), skills, backgroundReview: true };
  await skillManageTool.handler({ action: 'create', name: 'bg', content: FM('bg') }, ctx);
  expect(skills.usageEntries().find(([n]) => n === 'bg')?.[1].agentCreated).toBe(true);
});

test('skill_view 记一次 view', async () => {
  skills.create('demo2', FM('demo2'));
  await skillViewTool.handler({ name: 'demo2' }, ctxA());
  expect(skills.usageEntries().find(([n]) => n === 'demo2')?.[1].viewCount).toBe(1);
});
```
（`ctxA`/`FM` 见该文件 Task b-1 已加的助手;`skillViewTool`/`skillManageTool`/`createLogger` 已 import。）

b. 追加到 `packages/agent/src/skill-review.test.ts`（复用其 `scripted`/`reviewCtx`/`tc`/`SKILL`/`skills`/`registry`）：
```ts
test('runSkillReview 写入标记为 agent 建(backgroundReview 注入)', async () => {
  const { provider } = scripted([
    { content: null, toolCalls: [tc('1', 'skill_manage', { action: 'create', name: 'learned', content: SKILL('learned') })], finishReason: 'tool_calls' },
    { content: '完成。', toolCalls: [], finishReason: 'stop' },
  ]);
  await runSkillReview({ provider, registry, model: 'm' }, snapshot, reviewCtx());
  expect(skills.usageEntries().find(([n]) => n === 'learned')?.[1].agentCreated).toBe(true);
});
```
Run `npx vitest run skills skill-review` → 新增 FAIL。

- [ ] **Step 2: 实现**

a. `packages/tools/src/registry.ts` `ToolContext` 加字段：
```ts
  backgroundReview?: boolean;
```

b. `packages/tools/src/builtin/skills.ts`：
- skill_view handler 在 `return content;` 之前加：`ctx.skills.recordView(name);`
- skill_manage `case 'create'`：把 `ctx.skills.create(name, args.content, args.category);` 改为
  `ctx.skills.create(name, args.content, args.category, { agentCreated: ctx.backgroundReview ?? false });`

c. `packages/agent/src/skill-review.ts`：把工具执行行
```ts
        const output = await deps.registry.call(call.name, call.arguments, ctx);
```
改为
```ts
        const output = await deps.registry.call(call.name, call.arguments, { ...ctx, backgroundReview: true });
```

- [ ] **Step 3: 跑测试** `npx vitest run skills skill-review` → PASS;`pnpm -r exec tsc --noEmit` → clean。
- [ ] **Step 4: 提交**
```bash
git add packages/tools/src/registry.ts packages/tools/src/builtin/skills.ts packages/tools/src/builtin/skills.test.ts packages/agent/src/skill-review.ts packages/agent/src/skill-review.test.ts
git commit -m "$(printf 'feat: provenance 接线(skill_view recordView / skill_manage agentCreated / review 注入 backgroundReview)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 6：config.skillArchiveDays（parseIntConfig 泛化）

**Files:**
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/src/config.test.ts`

- [ ] **Step 1: 写失败测试** — 追加（复用 `HOME()` hermetic）：
```ts
test('skillArchiveDays 默认 30', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k' } as NodeJS.ProcessEnv).skillArchiveDays).toBe(30);
});
test('skillArchiveDays 读 env', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k', HERMES_SKILL_ARCHIVE_DAYS: '7' } as NodeJS.ProcessEnv).skillArchiveDays).toBe(7);
});
test('skillArchiveDays=0 关闭', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k', HERMES_SKILL_ARCHIVE_DAYS: '0' } as NodeJS.ProcessEnv).skillArchiveDays).toBe(0);
});
test('skillArchiveDays 非法回退 30', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k', HERMES_SKILL_ARCHIVE_DAYS: 'x' } as NodeJS.ProcessEnv).skillArchiveDays).toBe(30);
});
test('skillNudgeInterval 仍默认 10(回归)', () => {
  expect(loadConfig({ ...HOME(), GLM_API_KEY: 'k' } as NodeJS.ProcessEnv).skillNudgeInterval).toBe(10);
});
```
Run `npx vitest run config` → 新增 FAIL。

- [ ] **Step 2: 实现** — 改 `packages/core/src/config.ts`：

a. `HermesConfig` 接口加：`skillArchiveDays: number;`

b. 把现有 `parseInterval`(硬编码默认 10)泛化为带默认参的 `parseIntConfig`：
```ts
  const parseIntConfig = (v: string | undefined, fileVal: unknown, fallback: number): number => {
    if (v !== undefined && v.trim() !== '') {
      const n = Number(v);
      return Number.isNaN(n) ? fallback : n;
    }
    if (typeof fileVal === 'number') return fileVal;
    return fallback;
  };
```
（删除旧 `parseInterval`。）

c. return 对象里：
```ts
    skillNudgeInterval: parseIntConfig(env.HERMES_SKILL_NUDGE_INTERVAL, fromFile.skillNudgeInterval, 10),
    skillArchiveDays: parseIntConfig(env.HERMES_SKILL_ARCHIVE_DAYS, fromFile.skillArchiveDays, 30),
```

- [ ] **Step 3: 跑测试** `npx vitest run config` → PASS;`pnpm -r exec tsc --noEmit` → clean。
- [ ] **Step 4: 提交**
```bash
git add packages/core/src/config.ts packages/core/src/config.test.ts
git commit -m "$(printf 'feat(core): config.skillArchiveDays + parseIntConfig 泛化(默认参)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 7：CLI 接线（启动 curator + /curate）

**Files:**
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/repl.ts`

> CLI 集成 glue,无单测;验收靠 tsc + 全量 + 手测。可测逻辑(runCurator)已在 Task 4 覆盖。

- [ ] **Step 1: 改 `apps/cli/src/main.ts`**

a. import 增补 `runCurator`：把 `@hermes/core` 的 import 加上 `runCurator`。

b. 在 `const skills = new SkillStore(...)`(约 17 行)之后、`const deps = ...`(约 36 行)之前,加启动 curator：
```ts
  const curated = runCurator(skills, { archiveAfterDays: config.skillArchiveDays, now: new Date(), logger });
  if (curated.archived.length) {
    console.log(`🗃 已归档 ${curated.archived.length} 个久未用技能:${curated.archived.join(', ')}`);
  }
```

c. repl 调用第三参加 `skillArchiveDays`：
```ts
    await repl(deps, { cwd: process.cwd(), logger }, { approvalMode: config.approvalMode ?? 'manual', skillNudgeInterval: config.skillNudgeInterval, skillArchiveDays: config.skillArchiveDays });
```

- [ ] **Step 2: 改 `apps/cli/src/repl.ts`**

a. import 增补:把 `@hermes/agent` 的 import 旁,从 `@hermes/core` 加 `runCurator`(repl.ts 已从 @hermes/core import `allowlistPath`,把 `runCurator` 并入)。

b. `ReplOptions` 加字段：
```ts
export interface ReplOptions { approvalMode: 'manual' | 'off'; skillNudgeInterval: number; skillArchiveDays: number }
```

c. 在斜杠命令区(如 `/tools` 之后)加 `/curate`：
```ts
    if (line === '/curate') {
      if (options.skillArchiveDays <= 0) { console.log(pc.dim('归档已关闭(HERMES_SKILL_ARCHIVE_DAYS=0)')); continue; }
      const rep = runCurator(deps.skills, { archiveAfterDays: options.skillArchiveDays, now: new Date(), logger: ctx.logger });
      console.log(rep.archived.length ? pc.dim(`🗃 已归档:${rep.archived.join(', ')}`) : pc.dim('无可归档技能'));
      continue;
    }
```

d. `/help` 文案加入 `/curate`：把 help 行改为含 `/curate 整理技能`。

- [ ] **Step 3: 校验**
```bash
pnpm -r exec tsc --noEmit
npx vitest run
```
Expected: tsc 干净;全量绿(212 + Task1-6 新增,无回归)。

- [ ] **Step 4: 提交**
```bash
git add apps/cli/src/main.ts apps/cli/src/repl.ts
git commit -m "$(printf 'feat(cli): 启动时跑 curator + /curate 命令\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 8：文档更新（README + ROADMAP）

**Files:**
- Modify: `README.md`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: README.md**
- 顶部状态行:`技能（… + 后台自改进 + 自清理）✅`。
- 阶段列表追加:`- 技能 c-2（provenance + curator 归档）✅ — \`.usage.json\` 记录来源/使用 + 启动·\`/curate\` 自动归档久未用的 agent 自建技能（用户建永不归档）`。
- 「技能 (Skills)」小节加一条:`自清理:\`.usage.json\` 记录每条技能的来源(用户建/agent 建)与使用情况;CLI 启动时(及 \`/curate\`)把 agent 自建且久未使用(默认 30 天,\`HERMES_SKILL_ARCHIVE_DAYS=0\` 关闭)的技能移到 \`.archive/\`(可手工恢复);用户手建技能永不自动归档。` 并把推迟项收窄为 `curator 合并(LLM 判重)、技能支持文件、记忆自改进留待后续。`
- 「路线图」行:把 `技能 c-余（…，下一步）` 改为 `技能 c-2（provenance+curator 归档）✅ → 技能 c-3（curator 合并 + 支持文件 + 记忆自改进，下一步）`。
- 「已知限制」:把后台自改进那条之后补 `provenance + 自动归档已支持（技能 c-2）;curator 合并、技能支持文件、记忆自改进仍未实现（后续）`。
- CLI 斜杠命令说明(运行小节)加 `/curate`。

- [ ] **Step 2: docs/ROADMAP.md**
- 阶段总览表:把 `技能 c-余 | curator 生命周期 + provenance + 技能支持文件 | ⏸️ 计划` 拆成:
```
| 技能 c-2 | provenance(.usage.json)+ curator 归档(启动/手动) | ✅ 完成 |
| 技能 c-3 | curator 合并(LLM)+ 技能支持文件 + 记忆自改进 | ⏸️ 计划 |
```
- 把 `### 技能 c-余 … ⏸️ 推迟` 小节改为 `### 技能 c-2:provenance + curator 归档 ✅`,写「已做(MVP)」:SkillUsage(.usage.json,create/record/remove,缺条目=用户建)、SkillStore 集成(provenance 记录 + recordView + archive 移到 .archive + 扫描跳过)、runCurator(只归档 agentCreated+active+超阈值,now 可注入,坏时间戳不归档,best-effort)、provenance 接线(review 写入经 registry.call 注入 backgroundReview→agentCreated)、config skillArchiveDays(默认30,0=关)、CLI 启动跑 + /curate。再加一节 `### 技能 c-3 ⏸️ 推迟`:curator 合并(LLM 判重)、技能支持文件(write_file/remove_file)、记忆自改进、归档恢复命令、stale 预警态。
- 「已知限制」「运维备忘」同步补一行:`技能自动归档 HERMES_SKILL_ARCHIVE_DAYS(默认30,0=关);归档存 ~/.hermes-ts/skills/.archive/;只动 agent 自建技能`。

- [ ] **Step 3: 提交**
```bash
git add README.md docs/ROADMAP.md
git commit -m "$(printf 'docs: 技能 c-2 provenance + curator 完成,更新 README/ROADMAP\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## 完成后（控制者执行，非单任务）

- 派最终整体 code-review 子代理审 `main..HEAD` 全 diff（重点:provenance 不变量「缺条目=用户建」「同名重建重置」、curator 只动 agent 建、归档路径安全、热更新/扫描跳过、best-effort 容错、全 review 路径 agentCreated 贯通）。
- 修阻塞项后用 superpowers:finishing-a-development-branch 收尾（用户惯例:按 1）。
- 手测提示:`HERMES_SKILL_ARCHIVE_DAYS=...` 下,让后台自改进造几个技能(agent 建)、隔时或改系统时钟后启动 CLI / `/curate`,观察 `🗃 已归档...` 且技能移入 `.archive/`;用户手建的技能不动;`=0` 时不归档。
