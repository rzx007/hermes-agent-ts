# 技能 b-1：skill_manage CRUD 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 agent 一个 `skill_manage` 工具，可在 `~/.hermes-ts/skills/` 下创建/整体重写/精确替换/删除技能，写入即时热更新内存索引，delete 走审批确认。

**Architecture:** 变更逻辑与文件系统操作落在 `@hermes/core` 的 `SkillStore`（它本就是内存索引所有者），工具层 `skill_manage` 只做参数分发与必填校验。`LoopDeps.skills` / `ToolContext.skills` / `ToolContext.approval` 注入管线在技能 a 与阶段 2.5 已就位，本次不改 loop/repl/main——`skill_manage` 自动拿到与 system prompt 同一个 `SkillStore` 实例，热更新天然生效。

**Tech Stack:** TypeScript(strict, NodeNext, noUncheckedIndexedAccess) · Vitest · Zod · yaml · node:fs。

**Spec:** `docs/superpowers/specs/2026-06-26-hermes-ts-skills-b-crud-design.md`

**基线（开工前先确认）:** `pnpm test` 当前 166 通过、`pnpm -r exec tsc --noEmit` 干净（分支 `phase-skills-b-crud`，已含本计划与 spec 两个文档提交）。

---

## 重要约定（实现者必读）

- 内部包指向源码（无需 build）；从 `@hermes/core` 用 `import type` 引类型。
- 工具用 `defineTool<T>()` 定义（`packages/tools/src/registry.ts:99`），禁止 `: ToolDef` 注解与 `as` 转换。
- 工具 handler 抛错 → `ToolRegistry.call`（registry.ts:89-94）捕获转成 `Error: ...` 字符串回灌模型。故**校验失败一律 `throw new Error(...)`**，不要自己拼错误返回（delete 被拒是唯一例外：返回拒绝原因字符串）。
- `SkillEntry` 的 `skills[]` 与 `byName` 持有**同一对象**；edit/patch **就地改** `content`/`description`，不要新建对象替换。
- 原子写：写 `*.tmp` 同目录 + `renameSync`；内存**仅在写盘成功后**才改。
- 现有 `SkillStore`（`packages/core/src/skill-store.ts`）的 `parseSkill(root, file)` 从路径反推 category、从 frontmatter-或-目录名取 name——变更方法写盘后用 `this.parseSkill(this.dir, file)` 重解析以保证与全盘扫描一致。

---

## Task 1：SkillStore 基础重构 + 校验 + create()

**Files:**
- Modify: `packages/core/src/skill-store.ts`（加 `dir`/`logger` 字段、`SkillEntry.file`、模块级校验与原子写、`create()`）
- Test: `packages/core/src/skill-store.test.ts`（已存在，追加用例）

**背景:** 现有 `SkillStore` 只读：构造时扫盘建 `skills[]`/`byName`，对外 `list()`/`getContent()`/`renderIndex()`。本任务把它升级为可写的基础：保存根目录、给条目记文件路径、抽出可复用校验，并实现 `create()`。

- [ ] **Step 1: 写失败测试**

`packages/core/src/skill-store.test.ts` 已有共享 `let dir` + `beforeEach`(建临时 dir)/`afterEach`(清理)。**复用它们**——新测试直接用 `dir`，不要自建临时目录、不要逐测试 `rmSync`（afterEach 已清）。只需：

1. 把第 2 行 import 补上 `existsSync, readFileSync`：
   ```ts
   import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
   ```
2. 在 `writeSkill` 助手之后加一个 `SKILL` 文本助手：
   ```ts
   const SKILL = (name: string, desc = 'd', body = '正文内容') =>
     `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}`;
   ```
3. 文件末尾追加用例：

```ts
test('create 新建技能并即时热更新（list/getContent/renderIndex 立即可见）', () => {
  const store = new SkillStore(dir);
  const { path } = store.create('git-commit', SKILL('git-commit', '规范提交'));
  expect(existsSync(path)).toBe(true);
  expect(readFileSync(path, 'utf8')).toContain('name: git-commit');
  expect(store.getContent('git-commit')).toContain('正文内容');
  expect(store.list().map((s) => s.name)).toContain('git-commit');
  expect(store.renderIndex()).toContain('git-commit');
});

test('create 带 category 落在子目录，category 与入参一致', () => {
  const store = new SkillStore(dir);
  store.create('code-review', SKILL('code-review'), 'coding');
  expect(existsSync(join(dir, 'coding', 'code-review', 'SKILL.md'))).toBe(true);
  expect(store.list().find((s) => s.name === 'code-review')?.category).toBe('coding');
});

test('create 重名报错', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'));
  expect(() => store.create('a', SKILL('a'))).toThrow(/已存在/);
});

test('create 非法名报错', () => {
  const store = new SkillStore(dir);
  expect(() => store.create('Bad Name', SKILL('Bad Name'))).toThrow();
  expect(() => store.create('..', SKILL('..'))).toThrow();
});

test('create frontmatter.name 与参数 name 不一致报错', () => {
  const store = new SkillStore(dir);
  expect(() => store.create('foo', SKILL('bar'))).toThrow(/不一致/);
});

test('create 非法 category 报错', () => {
  const store = new SkillStore(dir);
  expect(() => store.create('x', SKILL('x'), 'bad/seg')).toThrow();
});

test('create 正文为空报错', () => {
  const store = new SkillStore(dir);
  expect(() => store.create('x', `---\nname: x\ndescription: d\n---\n\n   `)).toThrow(/正文/);
});

test('create 缺 frontmatter 报错', () => {
  const store = new SkillStore(dir);
  expect(() => store.create('x', '没有 frontmatter')).toThrow(/frontmatter/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @hermes/core test -- skill-store`
Expected: FAIL（`create` 不存在 / 类型错误）。

- [ ] **Step 3: 实现**

编辑 `packages/core/src/skill-store.ts`。

3a. 顶部 import 改为（补 `writeFileSync, renameSync, mkdirSync, rmSync, lstatSync` 与 `resolve`）：
```ts
import {
  readFileSync, readdirSync, existsSync, writeFileSync,
  renameSync, mkdirSync, rmSync, lstatSync, type Dirent,
} from 'node:fs';
import { join, relative, dirname, basename, sep, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Logger } from './logging.js';
```

3b. `SkillEntry` 加 `file`：
```ts
interface SkillEntry extends SkillMeta {
  content: string;
  file: string;
}
```

3c. 类字段与构造函数（保存 `dir`/`logger`）：
```ts
export class SkillStore {
  private readonly skills: SkillEntry[] = [];
  private readonly byName = new Map<string, SkillEntry>();
  private readonly dir: string;
  private readonly logger?: Logger;

  constructor(dir: string, logger?: Logger) {
    this.dir = dir;
    this.logger = logger;
    if (!existsSync(dir)) return;
    const files = this.findSkillFiles(dir).sort();
    for (const file of files) {
      try {
        const entry = this.parseSkill(dir, file);
        if (this.byName.has(entry.name)) {
          logger?.warn(`技能名 "${entry.name}" 重复,忽略 ${file}`);
          continue;
        }
        this.skills.push(entry);
        this.byName.set(entry.name, entry);
      } catch (e) {
        logger?.warn(`加载技能失败 ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
```
（`list()`/`getContent()`/`renderIndex()`/`findSkillFiles()` 保持不变。）

3d. `parseSkill` 返回值加 `file`（改最后一行 return）：
```ts
    return { name, description, category, content: body, file };
```

3e. 新增 `create()` 方法（放在 `renderIndex()` 之后、`findSkillFiles()` 之前）：
```ts
  create(name: string, content: string, category?: string): { path: string } {
    validateSkillName(name);
    if (category !== undefined) validateCategory(category);
    const meta = validateAndParseContent(content);
    if (meta.name !== name) {
      throw new Error(`frontmatter 的 name "${meta.name}" 与参数 name "${name}" 不一致`);
    }
    if (this.byName.has(name)) throw new Error(`技能 "${name}" 已存在`);
    const skillDir = category !== undefined ? join(this.dir, category, name) : join(this.dir, name);
    const file = join(skillDir, 'SKILL.md');
    this.assertWithinRoot(file);
    mkdirSync(skillDir, { recursive: true });
    atomicWrite(file, content);
    const entry = this.parseSkill(this.dir, file);
    this.skills.push(entry);
    this.byName.set(entry.name, entry);
    return { path: file };
  }

  private assertWithinRoot(p: string): void {
    const root = resolve(this.dir);
    const resolved = resolve(p);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new Error(`路径越界:${p} 不在技能根 ${this.dir} 内`);
    }
  }
```

3f. 文件末尾（`splitFrontmatter` 旁）新增模块级校验与原子写：
```ts
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_NAME = 64;
const MAX_DESC = 1024;
const MAX_CONTENT = 100000;

export function validateSkillName(name: string): void {
  if (name.length === 0 || name.length > MAX_NAME || !NAME_RE.test(name)) {
    throw new Error(`非法技能名 "${name}":须匹配 ^[a-z0-9][a-z0-9._-]*$ 且长度 1–${MAX_NAME}`);
  }
}

export function validateCategory(category: string): void {
  if (category.length === 0 || category.length > MAX_NAME || !NAME_RE.test(category)) {
    throw new Error(`非法分类 "${category}":须为单段且匹配 ^[a-z0-9][a-z0-9._-]*$`);
  }
}

/** 校验完整 SKILL.md 文本并取出 name/description/body；失败抛错 */
export function validateAndParseContent(content: string): { name: string; description: string; body: string } {
  if (content.length > MAX_CONTENT) {
    throw new Error(`SKILL.md 过大(${content.length} > ${MAX_CONTENT} 字符)`);
  }
  const { frontmatter, body } = splitFrontmatter(content);
  if (frontmatter === null) throw new Error('SKILL.md 必须以 YAML frontmatter(--- 包裹)开头');
  const parsed: unknown = parseYaml(frontmatter);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('frontmatter 必须是 YAML 映射');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.length === 0) throw new Error('frontmatter 缺少 name');
  if (typeof obj.description !== 'string' || obj.description.length === 0) {
    throw new Error('frontmatter 缺少 description');
  }
  if (obj.description.length > MAX_DESC) throw new Error(`description 过长(> ${MAX_DESC} 字符)`);
  if (body.trim().length === 0) throw new Error('SKILL.md 正文(frontmatter 之后)不能为空');
  return { name: obj.name, description: obj.description, body };
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @hermes/core test -- skill-store`
Expected: PASS（含原有只读用例 + 新增 create 用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/skill-store.ts packages/core/src/skill-store.test.ts
git commit -m "feat(core): SkillStore 可写基础 + 校验 + create()"
```

---

## Task 2：SkillStore edit() + patch()

**Files:**
- Modify: `packages/core/src/skill-store.ts`（加 `edit()`/`patch()`）
- Test: `packages/core/src/skill-store.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `skill-store.test.ts`（复用共享 `dir` 与 Task 1 的 `SKILL` 助手；afterEach 清理，勿自建/自删临时目录）：

```ts
test('edit 整体重写并就地更新（skills 与 byName 同步、无 desync）', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a', '旧描述', '旧正文'));
  store.edit('a', SKILL('a', '新描述', '新正文'));
  expect(store.getContent('a')).toContain('新正文');
  expect(store.getContent('a')).not.toContain('旧正文');
  // list（读 skills[]）与 getContent（读 byName）必须一致
  expect(store.list().find((s) => s.name === 'a')?.description).toBe('新描述');
});

test('edit 不存在的技能报错', () => {
  const store = new SkillStore(dir);
  expect(() => store.edit('nope', SKILL('nope'))).toThrow(/不存在/);
});

test('edit 改 frontmatter name 被拒', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'));
  expect(() => store.edit('a', SKILL('b'))).toThrow(/name/);
});

test('patch 精确替换（唯一）', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a', 'd', '步骤一：foo'));
  store.patch('a', '步骤一：foo', '步骤一：bar');
  expect(store.getContent('a')).toContain('步骤一：bar');
});

test('patch 未找到报错', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'));
  expect(() => store.patch('a', '不存在的文本', 'x')).toThrow(/未找到/);
});

test('patch 不唯一报错（除非 replace_all）', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a', 'd', 'dup dup dup'));
  expect(() => store.patch('a', 'dup', 'x')).toThrow(/不唯一/);
  store.patch('a', 'dup', 'x', true);
  expect(store.getContent('a')).toContain('x x x');
});

test('patch 含 $ 的替换不被损坏', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a', 'd', 'PRICE_HERE'));
  store.patch('a', 'PRICE_HERE', '$1.00 与 $name');
  expect(store.getContent('a')).toContain('$1.00 与 $name');
});

test('patch 改坏 frontmatter 被拒', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'));
  // 把 description 整行删掉 → 改后 frontmatter 缺字段
  expect(() => store.patch('a', 'description: d\n', '')).toThrow(/description/);
});

test('patch 改 frontmatter name 被拒', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'));
  expect(() => store.patch('a', 'name: a', 'name: b')).toThrow(/name/);
});

test('patch 空 old_string 报错', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'));
  expect(() => store.patch('a', '', 'x')).toThrow();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @hermes/core test -- skill-store`
Expected: FAIL（`edit`/`patch` 不存在）。

- [ ] **Step 3: 实现**

在 `skill-store.ts` 的 `create()` 之后新增：
```ts
  edit(name: string, content: string): { path: string } {
    const existing = this.byName.get(name);
    if (!existing) throw new Error(`技能 "${name}" 不存在`);
    const meta = validateAndParseContent(content);
    if (meta.name !== name) {
      throw new Error(`不允许修改 frontmatter 的 name(现为 "${name}",新内容为 "${meta.name}");改名请删除后重建`);
    }
    atomicWrite(existing.file, content);
    existing.content = meta.body;
    existing.description = meta.description;
    return { path: existing.file };
  }

  patch(name: string, oldString: string, newString: string, replaceAll = false): { path: string } {
    if (oldString.length === 0) throw new Error('patch 的 old_string 不能为空');
    const existing = this.byName.get(name);
    if (!existing) throw new Error(`技能 "${name}" 不存在`);
    const raw = readFileSync(existing.file, 'utf8');
    const occurrences = raw.split(oldString).length - 1;
    if (occurrences === 0) throw new Error('patch 未找到待替换文本(old_string)');
    if (!replaceAll && occurrences > 1) {
      throw new Error(`patch 待替换文本出现 ${occurrences} 次,不唯一;请用 replace_all 或扩大上下文`);
    }
    const next = raw.split(oldString).join(newString);
    const meta = validateAndParseContent(next);
    if (meta.name !== name) throw new Error('patch 不可修改 frontmatter 的 name');
    atomicWrite(existing.file, next);
    existing.content = meta.body;
    existing.description = meta.description;
    return { path: existing.file };
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @hermes/core test -- skill-store`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/skill-store.ts packages/core/src/skill-store.test.ts
git commit -m "feat(core): SkillStore edit() + patch()"
```

---

## Task 3：SkillStore delete() + 路径安全

**Files:**
- Modify: `packages/core/src/skill-store.ts`（加 `delete()`）
- Test: `packages/core/src/skill-store.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
test('delete 删除技能并移出索引', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'));
  expect(existsSync(join(dir, 'a', 'SKILL.md'))).toBe(true);
  store.delete('a');
  expect(existsSync(join(dir, 'a'))).toBe(false);
  expect(store.getContent('a')).toBeNull();
  expect(store.list().map((s) => s.name)).not.toContain('a');
});

test('delete 不存在的技能报错', () => {
  const store = new SkillStore(dir);
  expect(() => store.delete('nope')).toThrow(/不存在/);
});

test('delete 软链接技能目录被拒（不删 symlink/junction）', async () => {
  // 关键：扫盘会跳过 symlink 目录(isDirectory()=false)，所以不能靠扫描发现一个 symlink 技能。
  // 正确做法：先正常 create 一个真实技能（store 内存已有该条目），
  // 再把它的磁盘目录替换成 junction，然后 delete() 的 lstat 守卫即可命中。
  const { symlinkSync } = await import('node:fs');
  const store = new SkillStore(dir);
  store.create('a', SKILL('a')); // byName 有 'a'，file=dir/a/SKILL.md
  const target = mkdtempSync(join(tmpdir(), 'hermes-skill-tgt-'));
  rmSync(join(dir, 'a'), { recursive: true, force: true });
  let linked = true;
  try {
    symlinkSync(target, join(dir, 'a'), 'junction'); // Windows junction 无需管理员
  } catch {
    linked = false; // 平台不支持则跳过断言（仍通过）
  }
  if (linked) {
    expect(() => store.delete('a')).toThrow(/symlink|链接/i);
  }
  rmSync(target, { recursive: true, force: true });
});
```
> 注：symlink 测试用 `async () =>`（因 `await import('node:fs')`）。`target` 单独建/删（afterEach 只清 `dir`）。根目录删除由 `delete()` 内 `resolved === root` 断言保护，公开 API 难触发（技能目录至少深一层），靠断言代码 + 评审覆盖。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @hermes/core test -- skill-store`
Expected: FAIL（`delete` 不存在）。

- [ ] **Step 3: 实现**

在 `patch()` 之后新增：
```ts
  delete(name: string): void {
    const existing = this.byName.get(name);
    if (!existing) throw new Error(`技能 "${name}" 不存在`);
    const skillDir = dirname(existing.file);
    const root = resolve(this.dir);
    const resolved = resolve(skillDir);
    if (resolved === root) throw new Error('拒绝删除技能根目录');
    if (!resolved.startsWith(root + sep)) throw new Error('拒绝删除技能根目录之外的路径');
    if (lstatSync(skillDir).isSymbolicLink()) throw new Error('拒绝删除 symlink/junction 链接目录');
    rmSync(skillDir, { recursive: true, force: true });
    const idx = this.skills.indexOf(existing);
    if (idx >= 0) this.skills.splice(idx, 1);
    this.byName.delete(name);
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @hermes/core test -- skill-store`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/skill-store.ts packages/core/src/skill-store.test.ts
git commit -m "feat(core): SkillStore delete() + 路径安全"
```

---

## Task 4：ApprovalGuard.confirm() 通用确认

**Files:**
- Modify: `packages/tools/src/approval.ts:53-118`（`ApprovalGuard` 加 `confirm()`）
- Test: `packages/tools/src/approval.test.ts`（已存在，追加用例）

**背景:** `check()` 对命令字符串跑 `detectDangerous`，`skill:delete:x` 会被判 safe 直接放行，无法用于 delete 确认。新增 `confirm()`：复用同一 `prompt` 回调与 allowlist，但**不经危险检测**，对任意操作都走确认流程。

- [ ] **Step 1: 写失败测试**

追加到 `packages/tools/src/approval.test.ts`（先看文件现有 import 与构造 `ApprovalGuard` 的写法，复用同样的临时 allowlist 路径手法）：

```ts
test('confirm: off 模式直接放行', async () => {
  const g = new ApprovalGuard({ mode: 'off', allowlistPath: join(tmpdir(), 'al-off.json') });
  const r = await g.confirm({ command: 'skill:delete:x', description: '删除技能 x' });
  expect(r.allowed).toBe(true);
});

test('confirm: 无 prompt 通道则阻止', async () => {
  const g = new ApprovalGuard({ mode: 'manual', allowlistPath: join(tmpdir(), 'al-noprompt.json') });
  const r = await g.confirm({ command: 'skill:delete:x', description: '删除技能 x' });
  expect(r.allowed).toBe(false);
  expect(r.reason).toBeTruthy();
});

test('confirm: deny 阻止', async () => {
  const g = new ApprovalGuard({ mode: 'manual', allowlistPath: join(tmpdir(), 'al-deny.json'), prompt: async () => 'deny' });
  const r = await g.confirm({ command: 'skill:delete:x', description: '删除技能 x' });
  expect(r.allowed).toBe(false);
});

test('confirm: session 记忆后同命令免确认', async () => {
  let calls = 0;
  const g = new ApprovalGuard({
    mode: 'manual', allowlistPath: join(tmpdir(), 'al-session.json'),
    prompt: async () => { calls++; return 'session'; },
  });
  expect((await g.confirm({ command: 'skill:delete:x', description: 'd' })).allowed).toBe(true);
  expect((await g.confirm({ command: 'skill:delete:x', description: 'd' })).allowed).toBe(true);
  expect(calls).toBe(1); // 第二次走 sessionAllow，不再 prompt
});

test('confirm: always 落盘持久化', async () => {
  const al = join(mkdtempSync(join(tmpdir(), 'al-always-')), 'allowlist.json');
  const g = new ApprovalGuard({ mode: 'manual', allowlistPath: al, prompt: async () => 'always' });
  expect((await g.confirm({ command: 'skill:delete:x', description: 'd' })).allowed).toBe(true);
  expect(readFileSync(al, 'utf8')).toContain('skill:delete:x');
});
```
> 补 import：确保测试顶部有 `mkdtempSync, readFileSync` from `node:fs`、`tmpdir` from `node:os`、`join` from `node:path`（缺则补）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @hermes/tools test -- approval`
Expected: FAIL（`confirm` 不存在）。

- [ ] **Step 3: 实现**

在 `packages/tools/src/approval.ts` 的 `check()` 方法之后（约 approval.ts:97 之后）新增：
```ts
  /**
   * 通用确认（不经 detectDangerous）：用于非 shell 命令的不可逆操作（如删除技能）。
   * 复用同一 prompt 回调与 allowlist；语义与 check 的危险分支一致。
   */
  async confirm(req: ApprovalRequest): Promise<{ allowed: boolean; reason?: string }> {
    if (this.mode === 'off') return { allowed: true };
    if (this.sessionAllow.has(req.command) || this.persistentAllow.has(req.command)) {
      return { allowed: true };
    }
    if (!this.prompt) {
      return { allowed: false, reason: `已阻止:${req.description} 需要确认,但当前无交互审批通道。` };
    }
    let decision: ApprovalDecision;
    try {
      decision = await this.prompt(req);
    } catch {
      decision = 'deny';
    }
    if (decision === 'deny') return { allowed: false, reason: '用户拒绝了该操作。' };
    if (decision === 'session') this.sessionAllow.add(req.command);
    if (decision === 'always') {
      this.sessionAllow.add(req.command);
      this.persistentAllow.add(req.command);
      this.save();
    }
    return { allowed: true };
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @hermes/tools test -- approval`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/tools/src/approval.ts packages/tools/src/approval.test.ts
git commit -m "feat(tools): ApprovalGuard.confirm() 通用确认"
```

---

## Task 5：skill_manage 工具 + 注册

**Files:**
- Modify: `packages/tools/src/builtin/skills.ts`（加 `skillManageTool`）
- Modify: `packages/tools/src/builtin/index.ts:10,12-16,18-28`（import + 两处注册）
- Test: `packages/tools/src/builtin/skills.test.ts`（已存在，追加用例）

- [ ] **Step 1: 写失败测试**

先看 `packages/tools/src/builtin/skills.test.ts` 现有写法（它已测 `skillViewTool`，复用其构造 `SkillStore`/`ToolContext` 的手法）。追加：

```ts
// 顶部若无则补：import { skillManageTool } from './skills.js';
//             import { SkillStore } from '@hermes/core';
//             import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';

function ctxWith(skills: SkillStore, approval?: unknown) {
  return { cwd: process.cwd(), logger: console as never, skills, approval } as never;
}
const FM = (name: string) => `---\nname: ${name}\ndescription: d\n---\n\n正文`;

test('skill_manage create 新建并热更新可见', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-create-'));
  const skills = new SkillStore(dir);
  const ctx = ctxWith(skills);
  const out = await skillManageTool.handler({ action: 'create', name: 'a', content: FM('a') } as never, ctx);
  expect(out).toContain('已创建');
  expect(skills.getContent('a')).toContain('正文');
  rmSync(dir, { recursive: true, force: true });
});

test('skill_manage create 缺 content 报错（回灌模型）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-nocontent-'));
  const skills = new SkillStore(dir);
  await expect(skillManageTool.handler({ action: 'create', name: 'a' } as never, ctxWith(skills)))
    .rejects.toThrow(/content/);
  rmSync(dir, { recursive: true, force: true });
});

test('skill_manage patch 缺 new_string 报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-nopatch-'));
  const skills = new SkillStore(dir);
  skills.create('a', FM('a'));
  await expect(skillManageTool.handler({ action: 'patch', name: 'a', old_string: '正文' } as never, ctxWith(skills)))
    .rejects.toThrow(/new_string|old_string/);
  rmSync(dir, { recursive: true, force: true });
});

test('skill_manage delete 经 approval 确认（允许）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-del-ok-'));
  const skills = new SkillStore(dir);
  skills.create('a', FM('a'));
  const approval = { confirm: async () => ({ allowed: true }) };
  const out = await skillManageTool.handler({ action: 'delete', name: 'a' } as never, ctxWith(skills, approval));
  expect(out).toContain('已删除');
  expect(skills.getContent('a')).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test('skill_manage delete 被 approval 拒绝则不删', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-del-deny-'));
  const skills = new SkillStore(dir);
  skills.create('a', FM('a'));
  const approval = { confirm: async () => ({ allowed: false, reason: '用户拒绝了该操作。' }) };
  const out = await skillManageTool.handler({ action: 'delete', name: 'a' } as never, ctxWith(skills, approval));
  expect(out).toContain('拒绝');
  expect(skills.getContent('a')).not.toBeNull(); // 仍在
  rmSync(dir, { recursive: true, force: true });
});

test('skill_manage 无 ctx.skills 返回不可用', async () => {
  const out = await skillManageTool.handler(
    { action: 'create', name: 'a', content: FM('a') } as never,
    { cwd: process.cwd(), logger: console as never } as never,
  );
  expect(out).toBe('技能系统不可用。');
});

test('skill_manage 已注册（builtinTools 含 skill_manage）', async () => {
  const { builtinTools } = await import('./index.js');
  expect(builtinTools.map((t) => t.name)).toContain('skill_manage');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @hermes/tools test -- skills`
Expected: FAIL（`skillManageTool` 不存在）。

- [ ] **Step 3: 实现**

3a. 在 `packages/tools/src/builtin/skills.ts` 末尾追加（`skillViewTool` 之后）：
```ts
export const skillManageTool = defineTool({
  name: 'skill_manage',
  description:
    '管理技能(程序性知识):create=新建,edit=整体重写 SKILL.md,patch=精确替换正文片段,delete=删除。' +
    '技能为 SKILL.md(YAML frontmatter 必含 name/description,之后是正文)。create/edit 传 content;patch 传 old_string/new_string。',
  toolset: 'skills',
  schema: z.object({
    action: z.enum(['create', 'edit', 'patch', 'delete']),
    name: z.string().describe('技能名(lowercase,匹配 ^[a-z0-9][a-z0-9._-]*$,≤64)'),
    content: z.string().optional().describe('完整 SKILL.md(create/edit 必填)'),
    old_string: z.string().optional().describe('待替换文本(patch 必填,默认须唯一)'),
    new_string: z.string().optional().describe('替换为的文本(patch 必填)'),
    replace_all: z.boolean().optional().describe('替换全部出现(patch,默认 false)'),
    category: z.string().optional().describe('分类目录段(create 可选,单段)'),
  }),
  handler: async (args, ctx) => {
    if (!ctx.skills) return '技能系统不可用。';
    const { action, name } = args;
    switch (action) {
      case 'create': {
        if (args.content === undefined) throw new Error('create 需要 content(完整 SKILL.md)');
        ctx.skills.create(name, args.content, args.category);
        return `已创建技能 "${name}"。`;
      }
      case 'edit': {
        if (args.content === undefined) throw new Error('edit 需要 content(完整 SKILL.md)');
        ctx.skills.edit(name, args.content);
        return `已更新技能 "${name}"。`;
      }
      case 'patch': {
        if (args.old_string === undefined || args.new_string === undefined) {
          throw new Error('patch 需要 old_string 与 new_string');
        }
        ctx.skills.patch(name, args.old_string, args.new_string, args.replace_all ?? false);
        return `已 patch 技能 "${name}"。`;
      }
      case 'delete': {
        if (ctx.approval) {
          const r = await ctx.approval.confirm({ command: `skill:delete:${name}`, description: `删除技能 ${name}` });
          if (!r.allowed) return r.reason ?? '已取消删除。';
        }
        ctx.skills.delete(name);
        return `已删除技能 "${name}"。`;
      }
    }
  },
});
```
> 注：`switch` 已覆盖 enum 全部分支，TS 控制流可推断 handler 必返回 `string`。若编译器仍报“并非所有路径都返回”，在 switch 后加 `// 不可达` 处理：保持 switch 穷尽即可，不要加 default 以保留穷尽检查。

3b. 编辑 `packages/tools/src/builtin/index.ts`：
- 第 10 行 import 改为：`import { skillViewTool, skillManageTool } from './skills.js';`
- `builtinTools` 数组（12-16 行）加入 `skillManageTool`：
```ts
export const builtinTools = [
  readFileTool, writeFileTool, terminalTool,
  editFileTool, searchFilesTool, listDirTool,
  memoryTool, sessionSearchTool, skillViewTool, skillManageTool,
];
```
- `registerBuiltins`（18-28 行）末尾加：`registry.register(skillManageTool);`

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @hermes/tools test`
Expected: PASS（含 toolsets 等既有用例）。

- [ ] **Step 5: 全量校验 + 提交**

```bash
pnpm -r exec tsc --noEmit
pnpm test
git add packages/tools/src/builtin/skills.ts packages/tools/src/builtin/index.ts packages/tools/src/builtin/skills.test.ts
git commit -m "feat(tools): skill_manage 工具 + 注册(create/edit/patch/delete)"
```
Expected: tsc 干净；全量测试通过（166 + 新增约 30）。

---

## Task 6：文档更新（README + ROADMAP）

**Files:**
- Modify: `README.md`（当前状态行、阶段列表、@hermes/tools 段落、技能小节、路线图行、已知限制）
- Modify: `docs/ROADMAP.md`（技能 b 总览与子节）

- [ ] **Step 1: 更新 README.md**

逐处改（保持中文风格与既有格式一致）：
- 顶部「## 当前状态」标题：加入 `技能 b-1（skill_manage 写入）✅`。
- 阶段列表追加一行：`- 技能 b-1（skill_manage CRUD）✅ — \`skill_manage\` 创建/编辑/删除技能 + 即时热更新 + delete 审批确认`。
- **@hermes/tools** 段落：内置工具列表加入 `skill_manage`。
- 「## 技能 (Skills)」小节：把「创建 / 编辑技能（\`skill_manage\`）……留待后续阶段」改为：
  - 新增一条：`模型用 \`skill_manage\` 工具创建/整体重写(edit)/精确替换(patch)/删除技能;写入即时热更新,delete 经审批确认。`
  - 把推迟项收窄为：`后台技能自改进(self-improvement)与生命周期管家(curator)留待后续阶段。`
- 「## 路线图」行：把 `技能 b（skill_manage + 自改进，下一步）` 拆为 `技能 b-1（skill_manage CRUD）✅ → 技能 c（自改进 + curator，下一步）`。
- 「## 已知限制」：把「技能创建/编辑（\`skill_manage\`）与自改进仍未实现」改为「技能创建/编辑已支持(\`skill_manage\`);后台自改进与 curator 生命周期管理仍未实现(后续阶段)」。

- [ ] **Step 2: 更新 docs/ROADMAP.md**

先 Read `docs/ROADMAP.md` 找到技能 a/b 相关章节，把技能 b 标为：技能 b-1（skill_manage CRUD）✅ 已完成，注明范围（create/edit/patch/delete + 热更新 + delete 审批）；把自改进 fork、curator、支持文件、provenance 列为后续（技能 c）。与 README 表述一致。

- [ ] **Step 3: 提交**

```bash
git add README.md docs/ROADMAP.md
git commit -m "docs: 技能 b-1 skill_manage CRUD 完成,更新 README/ROADMAP"
```

---

## 完成后（控制者执行，非单任务）

- 派最终整体 code-review 子代理审 base..HEAD 全 diff。
- 修掉阻塞项后，用 superpowers:finishing-a-development-branch 走收尾（用户惯例：按 1 = 合并 main + 推送 + 保留分支)。
- 提示用户用真实 GLM Key 手测：让模型新建一个技能、patch 它、再让它 skill_view 读回、最后 delete（验证审批弹窗）。
