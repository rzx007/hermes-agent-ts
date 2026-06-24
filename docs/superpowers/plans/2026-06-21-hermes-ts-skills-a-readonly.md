# Hermes TS 技能 a:只读技能(Skills, read-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 从磁盘加载技能(SKILL.md)、在 system prompt 看到技能索引、用 `skill_view` 按需读取技能正文。

**Architecture:** `SkillStore`(@hermes/core,类比 MemoryStore)递归扫描 `~/.hermes-ts/skills/*/SKILL.md`、解析 frontmatter,提供 `list`/`getContent`/`renderIndex`。`skill_view` 工具(@hermes/tools)经 `ToolContext.skills` 读;`buildSystemPrompt` 经 `LoopDeps.skills.renderIndex()` 注入索引;CLI 创建唯一实例放进 deps 并每轮注入 ctx(沿用 memory 模式)。

**Tech Stack:** 沿用阶段 1-3b(Node 20+ / TS strict / pnpm / Vitest / Zod / yaml)。无新增依赖。

**Spec:** `docs/superpowers/specs/2026-06-21-hermes-ts-skills-a-readonly-design.md`

**前置状态:** 阶段 1/2/2.5/3a/3b 完成并合并。当前在 `phase-skills-a` 分支,基线已实测 **144 测试全绿**。内部包指向源码解析。工具用 `defineTool`,`registry.call` 捕获工具异常转错误字符串回灌。HERMES_HOME = `~/.hermes-ts`。`yaml` 是 @hermes/core 依赖。

---

## 文件结构总览

| 文件 | 职责 |
|------|------|
| `packages/core/src/skill-store.ts`(新) | SkillStore |
| `packages/core/src/skill-store.test.ts`(新) | |
| `packages/core/src/paths.ts`(改) | skillsDir() |
| `packages/core/src/paths.test.ts`(改) | |
| `packages/core/src/index.ts`(改) | 导出 skill-store |
| `packages/tools/src/registry.ts`(改) | ToolContext.skills?: SkillStore |
| `packages/tools/src/toolsets.ts`(改) | skills toolset + core.includes 加 skills |
| `packages/tools/src/toolsets.test.ts`(改) | |
| `packages/tools/src/builtin/skills.ts`(新) | skill_view 工具 |
| `packages/tools/src/builtin/skills.test.ts`(新) | |
| `packages/tools/src/builtin/index.ts`(改) | 注册 skill_view |
| `packages/agent/src/system-prompt.ts`(改) | buildSystemPrompt 加 skillsBlock? |
| `packages/agent/src/system-prompt.test.ts`(改) | |
| `packages/agent/src/conversation-loop.ts`(改) | LoopDeps.skills? + 注入 renderIndex() |
| `packages/agent/src/conversation-loop.test.ts`(改) | |
| `apps/cli/src/main.ts`(改) | 创建 SkillStore 入 deps |
| `apps/cli/src/repl.ts`(改) | 每轮注入 ctx.skills |

---

## Task 1:SkillStore

**Files:**
- Create: `packages/core/src/skill-store.ts`, `packages/core/src/skill-store.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: 写失败测试**

`packages/core/src/skill-store.test.ts`:
```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillStore } from './skill-store.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hermes-skill-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeSkill(rel: string, frontmatter: string, body: string): void {
  const full = join(dir, rel);
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`, 'utf8');
}

test('扫描加载 + frontmatter name/description', () => {
  writeSkill('demo', 'name: demo\ndescription: 演示技能', '# Demo\n步骤一二三');
  const s = new SkillStore(dir);
  const list = s.list();
  expect(list).toHaveLength(1);
  expect(list[0]!.name).toBe('demo');
  expect(list[0]!.description).toBe('演示技能');
});

test('getContent 返回正文(去 frontmatter)', () => {
  writeSkill('demo', 'name: demo\ndescription: d', '# Demo\n正文内容');
  const s = new SkillStore(dir);
  const content = s.getContent('demo')!;
  expect(content).toContain('# Demo');
  expect(content).toContain('正文内容');
  expect(content).not.toContain('description: d');
});

test('getContent 未知名返回 null', () => {
  const s = new SkillStore(dir);
  expect(s.getContent('nope')).toBeNull();
});

test('category:子目录 vs general', () => {
  writeSkill('coding/refactor', 'name: refactor\ndescription: r', 'body');
  writeSkill('toplevel', 'name: toplevel\ndescription: t', 'body');
  const s = new SkillStore(dir);
  const byName = Object.fromEntries(s.list().map((m) => [m.name, m.category]));
  expect(byName['refactor']).toBe('coding');
  expect(byName['toplevel']).toBe('general');
});

test('正文含 --- 水平线:只取第一个闭合 frontmatter', () => {
  writeSkill('hr', 'name: hr\ndescription: d', '正文上\n---\n正文下(水平线)');
  const s = new SkillStore(dir);
  const c = s.getContent('hr')!;
  expect(c).toContain('正文上');
  expect(c).toContain('正文下(水平线)');
  expect(c).not.toContain('description: d');
});

test('无 frontmatter:整文件为正文,name 回退目录名', () => {
  const full = join(dir, 'raw');
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, 'SKILL.md'), '# 无 frontmatter 的技能\n直接正文', 'utf8');
  const s = new SkillStore(dir);
  expect(s.list()[0]!.name).toBe('raw');
  expect(s.list()[0]!.description).toBe('');
  expect(s.getContent('raw')!).toContain('直接正文');
});

test('frontmatter 缺 name 回退目录名', () => {
  writeSkill('mydir', 'description: 只有描述', 'body');
  const s = new SkillStore(dir);
  expect(s.list()[0]!.name).toBe('mydir');
  expect(s.list()[0]!.description).toBe('只有描述');
});

test('frontmatter 是非对象(标量)→ 回退', () => {
  writeSkill('scalar', 'just a string', 'body');
  const s = new SkillStore(dir);
  expect(s.list()[0]!.name).toBe('scalar');
  expect(s.list()[0]!.description).toBe('');
});

test('renderIndex 含 name+description;空目录 → ""', () => {
  expect(new SkillStore(dir).renderIndex()).toBe('');
  writeSkill('demo', 'name: demo\ndescription: 演示', 'body');
  const idx = new SkillStore(dir).renderIndex();
  expect(idx).toContain('demo');
  expect(idx).toContain('演示');
});

test('解析失败的技能跳过不崩(坏 yaml)', () => {
  writeSkill('good', 'name: good\ndescription: g', 'body');
  // 坏 frontmatter:yaml 语法错误
  const bad = join(dir, 'bad');
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, 'SKILL.md'), '---\nname: [unclosed\n---\nbody', 'utf8');
  const s = new SkillStore(dir);
  // good 仍在;bad 要么跳过要么回退,但不能崩
  expect(s.list().some((m) => m.name === 'good')).toBe(true);
});

test('同名技能首个生效(按路径排序确定)', () => {
  writeSkill('a-first', 'name: dup\ndescription: 第一个', 'body A');
  writeSkill('z-second', 'name: dup\ndescription: 第二个', 'body Z');
  const s = new SkillStore(dir);
  // 路径排序 a-first 在前 → 它生效
  expect(s.getContent('dup')).toContain('body A');
  expect(s.list().filter((m) => m.name === 'dup')).toHaveLength(1);
});

test('目录不存在不崩', () => {
  expect(() => new SkillStore(join(dir, 'nonexistent'))).not.toThrow();
  expect(new SkillStore(join(dir, 'nonexistent')).list()).toEqual([]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/core/src/skill-store.test.ts`

- [ ] **Step 3: 实现 skill-store.ts**

`packages/core/src/skill-store.ts`:
```ts
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, dirname, basename, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Logger } from './logging.js';

export interface SkillMeta {
  name: string;
  description: string;
  category: string;
}

interface SkillEntry extends SkillMeta {
  content: string;
}

export class SkillStore {
  private readonly skills: SkillEntry[] = [];
  private readonly byName = new Map<string, SkillEntry>();

  constructor(dir: string, logger?: Logger) {
    if (!existsSync(dir)) return;
    const files = this.findSkillFiles(dir).sort(); // 排序保证确定性
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

  list(): SkillMeta[] {
    return this.skills.map(({ name, description, category }) => ({ name, description, category }));
  }

  getContent(name: string): string | null {
    return this.byName.get(name)?.content ?? null;
  }

  renderIndex(): string {
    if (this.skills.length === 0) return '';
    const byCat = new Map<string, SkillEntry[]>();
    for (const s of this.skills) {
      const arr = byCat.get(s.category) ?? [];
      arr.push(s);
      byCat.set(s.category, arr);
    }
    const lines: string[] = ['可用技能(用 skill_view 读取正文):'];
    for (const [cat, entries] of byCat) {
      lines.push(`### ${cat}`);
      for (const e of entries) lines.push(`- **${e.name}** — ${e.description}`);
    }
    return lines.join('\n');
  }

  // 递归查找所有 SKILL.md 的绝对路径
  private findSkillFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
      let entries: ReturnType<typeof readdirSync>;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        const full = join(d, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name === 'SKILL.md') out.push(full);
      }
    };
    walk(root);
    return out;
  }

  private parseSkill(root: string, file: string): SkillEntry {
    const raw = readFileSync(file, 'utf8');
    const { frontmatter, body } = splitFrontmatter(raw);
    let fmName: string | undefined;
    let fmDesc: string | undefined;
    if (frontmatter !== null) {
      const parsed: unknown = parseYaml(frontmatter);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.name === 'string') fmName = obj.name;
        if (typeof obj.description === 'string') fmDesc = obj.description;
      }
    }
    const skillDir = dirname(file);
    const name = fmName ?? basename(skillDir);
    const description = fmDesc ?? '';
    // category = skillDir 相对 root 的父路径;直接位于 root 下 → 'general'
    const relParent = relative(root, dirname(skillDir));
    const category = relParent === '' ? 'general' : relParent.split(sep).join('/');
    return { name, description, category, content: body };
  }
}

// 仅当首行为 '---' 才有 frontmatter,取第一个后续 '---' 作闭合
function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') return { frontmatter: null, body: raw };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      return {
        frontmatter: lines.slice(1, i).join('\n'),
        body: lines.slice(i + 1).join('\n'),
      };
    }
  }
  // 没有闭合 --- → 当作无 frontmatter
  return { frontmatter: null, body: raw };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/core/src/skill-store.test.ts`
Expected: PASS（12）

- [ ] **Step 5: 导出 + 全量 + typecheck + 提交**

在 `packages/core/src/index.ts` 追加:`export * from './skill-store.js';`
Run: `pnpm --filter @hermes/core exec tsc --noEmit`(干净)
Run: `pnpm vitest run`(144 + 12 = 156)
```bash
git add -A
git commit -m "feat(core): SkillStore(扫描 SKILL.md/frontmatter + list/getContent/renderIndex)"
```

---

## Task 2:paths.skillsDir

**Files:**
- Modify: `packages/core/src/paths.ts`, `packages/core/src/paths.test.ts`

- [ ] **Step 1: 写失败测试**

`paths.test.ts`:顶部 import 加 `skillsDir`;追加:
```ts
test('skillsDir 在 hermes home 下指向 skills', () => {
  expect(skillsDir({ HOME: '/home/u' }).replace(/\\/g, '/')).toBe('/home/u/.hermes-ts/skills');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/core/src/paths.test.ts`

- [ ] **Step 3: 实现**

`paths.ts` 追加:
```ts
export function skillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getHermesHome(env), 'skills');
}
```

- [ ] **Step 4: 通过 + typecheck + 提交**

Run: `pnpm vitest run packages/core`(全绿)
Run: `pnpm --filter @hermes/core exec tsc --noEmit`(干净)
```bash
git add -A
git commit -m "feat(core): paths.skillsDir"
```

---

## Task 3:ToolContext.skills + skills toolset

**Files:**
- Modify: `packages/tools/src/registry.ts`, `packages/tools/src/toolsets.ts`, `packages/tools/src/toolsets.test.ts`

- [ ] **Step 1: 写失败 toolset 测试**

`toolsets.test.ts` 追加:
```ts
test('skills toolset 存在且 core 包含它', () => {
  expect(Object.keys(TOOLSETS)).toContain('skills');
  expect(resolveToolset('skills')).toEqual(['skill_view']);
  expect(resolveToolset('core')).toContain('skill_view');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/tools/src/toolsets.test.ts`

- [ ] **Step 3: 改 toolsets.ts**

READ toolsets.ts。新增 skills 分组,把 'skills' 加入 core.includes(REPLACE 数组):
```ts
  skills: {
    description: '技能(程序性知识)',
    tools: ['skill_view'],
  },
  core: {
    description: '核心工具集',
    includes: ['file', 'terminal', 'memory', 'search', 'skills'],
  },
```
(core.includes 当前 `['file','terminal','memory','search']` → 加 `'skills'`。)

- [ ] **Step 4: ToolContext 加 skills**

`packages/tools/src/registry.ts`:把 `SkillStore` 并入现有 `@hermes/core` type import:`import type { MemoryStore, SessionDB, SkillStore } from '@hermes/core';`;`ToolContext` 加 `skills?: SkillStore;`。
(core 不依赖 tools,type-only 安全。)

- [ ] **Step 5: 通过 + 全量 + typecheck + 提交**

Run: `pnpm vitest run packages/tools/src/toolsets.test.ts`
Run: `pnpm --filter @hermes/tools exec tsc --noEmit`(干净)
Run: `pnpm vitest run`(全绿)
```bash
git add -A
git commit -m "feat(tools): skills toolset + ToolContext.skills"
```

---

## Task 4:skill_view 工具

**Files:**
- Create: `packages/tools/src/builtin/skills.ts`, `packages/tools/src/builtin/skills.test.ts`
- Modify: `packages/tools/src/builtin/index.ts`

- [ ] **Step 1: 写失败测试**

`packages/tools/src/builtin/skills.test.ts`:
```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillStore, createLogger } from '@hermes/core';
import { skillViewTool } from './skills.js';

let dir: string;
let skills: SkillStore;
const ctx = () => ({ cwd: process.cwd(), logger: createLogger('test'), skills });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-skv-'));
  const d = join(dir, 'demo');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), '---\nname: demo\ndescription: 演示\n---\n# Demo\n操作步骤', 'utf8');
  skills = new SkillStore(dir);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('skill_view 返回正文', async () => {
  const out = await skillViewTool.handler({ name: 'demo' }, ctx());
  expect(out).toContain('# Demo');
  expect(out).toContain('操作步骤');
});

test('skill_view 未知名报错(含可用名)', async () => {
  await expect(skillViewTool.handler({ name: 'nope' }, ctx())).rejects.toThrow(/demo/);
});

test('无 ctx.skills 返回不可用', async () => {
  const out = await skillViewTool.handler(
    { name: 'demo' },
    { cwd: process.cwd(), logger: createLogger('test') },
  );
  expect(out).toContain('不可用');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/tools/src/builtin/skills.test.ts`

- [ ] **Step 3: 实现 skills.ts**

`packages/tools/src/builtin/skills.ts`:
```ts
import { z } from 'zod';
import { defineTool } from '../registry.js';

export const skillViewTool = defineTool({
  name: 'skill_view',
  description: '读取某个技能的完整正文(操作步骤/最佳实践)。技能清单见系统提示中的「可用技能」索引。',
  toolset: 'skills',
  schema: z.object({ name: z.string().describe('技能名(见系统提示技能索引)') }),
  handler: async ({ name }, ctx) => {
    if (!ctx.skills) return '技能系统不可用。';
    const content = ctx.skills.getContent(name);
    if (content === null) {
      const avail = ctx.skills.list().map((s) => s.name).join(', ') || '(无)';
      throw new Error(`未找到技能 "${name}"。可用技能:${avail}`);
    }
    return content;
  },
});
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/tools/src/builtin/skills.test.ts`
Expected: PASS（3）

- [ ] **Step 5: 注册**

`packages/tools/src/builtin/index.ts`:import `skillViewTool`,加入 `builtinTools` 数组,在 `registerBuiltins` 加 `registry.register(skillViewTool);`。

- [ ] **Step 6: 全量 + typecheck + 提交**

Run: `pnpm vitest run`(全绿)
Run: `pnpm --filter @hermes/tools exec tsc --noEmit`(干净)
```bash
git add -A
git commit -m "feat(tools): skill_view 工具 + 注册"
```

---

## Task 5:系统提示注入

**Files:**
- Modify: `packages/agent/src/system-prompt.ts`, `packages/agent/src/system-prompt.test.ts`
- Modify: `packages/agent/src/conversation-loop.ts`, `packages/agent/src/conversation-loop.test.ts`

- [ ] **Step 1: 写 system-prompt 失败测试**

`system-prompt.test.ts` 追加:
```ts
test('buildSystemPrompt 带 skillsBlock 时包含它', () => {
  const out = buildSystemPrompt('/work', undefined, '可用技能:\n- **demo** — 演示');
  expect(out).toContain('demo');
});

test('buildSystemPrompt 不带 skillsBlock 不含技能标记', () => {
  expect(buildSystemPrompt('/work')).not.toContain('可用技能');
});

test('memory 与 skills 块可共存', () => {
  const out = buildSystemPrompt('/work', '记忆X', '可用技能:\n- **demo** — d');
  expect(out).toContain('记忆X');
  expect(out).toContain('demo');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/agent/src/system-prompt.test.ts`

- [ ] **Step 3: 改 system-prompt.ts**

READ `packages/agent/src/system-prompt.ts` 看清真实结构(现签名 `buildSystemPrompt(cwd, memoryBlock?)`,用 parts 数组;注意时间戳行的实际位置——不要移动任何现有行)。最小改动:
1. 签名加第三参:`buildSystemPrompt(cwd: string, memoryBlock?: string, skillsBlock?: string): string`。
2. **保持现有所有行原位不动**(身份/cwd/工具/时间/memory 块)。在现有 `memoryBlock` 的 `if(...)push` 块**紧后面**,以同样风格追加 skillsBlock 块:
```ts
  if (skillsBlock && skillsBlock.trim() !== '') {
    parts.push('', skillsBlock);
  }
```
3. 把顶部 `// TODO(阶段4): 注入技能 / 人格` 注释更新为 `// TODO(后续): 注入人格`(技能本阶段已做)。
> 注:skillsBlock 与 memoryBlock 的相对/绝对位置不影响功能(无测试断言顺序);只要二者都出现在 system prompt 即可。不要因为本步而调整时间戳行位置。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/agent/src/system-prompt.test.ts`

- [ ] **Step 5: 写 conversation-loop 失败测试**

`conversation-loop.test.ts` 追加(复用 scriptedProvider/makeDeps;mock skills):
```ts
test('注入 deps.skills 后 system 消息含技能索引', async () => {
  const seen: import('@hermes/core').Message[][] = [];
  const provider: Provider = {
    name: 'mock',
    async *complete(req) { seen.push(req.messages); yield { contentDelta: 'ok' }; },
    async aggregate(): Promise<CompletionResult> { return { content: 'ok', toolCalls: [], finishReason: 'stop' }; },
  };
  const { db, deps } = makeDeps(provider);
  const fakeSkills = { renderIndex: () => '可用技能:\n- **demo** — 演示' } as unknown as import('@hermes/core').SkillStore;
  const filtered = { ...deps, skills: fakeSkills };
  const s = db.createSession();
  for await (const _ of runConversation(filtered, s.id, 'hi', { cwd: '/', logger: createLogger('t') })) { /* drain */ }
  const sys = seen[0]!.find((m) => m.role === 'system');
  expect(sys?.content).toContain('demo');
});
```

- [ ] **Step 6: 运行确认失败**

Run: `pnpm vitest run packages/agent/src/conversation-loop.test.ts`

- [ ] **Step 7: 改 conversation-loop.ts**

- 顶部 `import type { MemoryStore } from '@hermes/core'` 处并入 `SkillStore`:`import type { MemoryStore, SkillStore } from '@hermes/core';`
- `LoopDeps` 加 `skills?: SkillStore;`
- 把 `buildSystemPrompt(ctx.cwd, deps.memory?.render())` 改为 `buildSystemPrompt(ctx.cwd, deps.memory?.render(), deps.skills?.renderIndex())`。
- 保留 ASCII 注释与所有逻辑。

- [ ] **Step 8: 通过 + 全量 + typecheck + 提交**

Run: `pnpm vitest run packages/agent`(全绿)
Run: `pnpm vitest run`(全绿)
Run: `pnpm --filter @hermes/agent exec tsc --noEmit`(干净)
```bash
git add -A
git commit -m "feat(agent): system prompt 注入技能索引 + LoopDeps.skills"
```

---

## Task 6:CLI 接线 + e2e + 文档

**Files:**
- Modify: `apps/cli/src/main.ts`, `apps/cli/src/repl.ts`, `README.md`, `docs/ROADMAP.md`

- [ ] **Step 1: 改 main.ts**

READ `apps/cli/src/main.ts`。
- import:`SkillStore, skillsDir` from `@hermes/core`(加到现有 core import)。
- 在创建其它 store 处加:`const skills = new SkillStore(skillsDir(), logger);`
- `deps` 对象加 `skills`。

- [ ] **Step 2: 改 repl.ts**

READ `apps/cli/src/repl.ts`。每轮 runConversation 的 ctx 加 `skills: deps.skills`:
`{ ...ctx, signal: controller.signal, approval: guard, memory: deps.memory, sessionDb: deps.db, skills: deps.skills }`

- [ ] **Step 3: typecheck + 冒烟 + 全量**

Run: `pnpm --filter @hermes/cli exec tsc --noEmit`(干净)
Run: `GLM_API_KEY= pnpm --filter @hermes/cli exec tsx src/main.ts`(打印缺 key 退出 1)
Run: `pnpm -r exec tsc --noEmit`(全包干净)
Run: `pnpm vitest run`(全绿)

- [ ] **Step 4: 手动验证(无需 key)**

写临时脚本(或 `apps/cli/src/_smoke_skills.ts` 跑后删):
```ts
import { SkillStore } from '@hermes/core';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const d = mkdtempSync(join(tmpdir(), 'smoke-sk-'));
const sd = join(d, 'demo'); mkdirSync(sd, { recursive: true });
writeFileSync(join(sd, 'SKILL.md'), '---\nname: demo\ndescription: 演示技能\n---\n# Demo\n步骤', 'utf8');
const s = new SkillStore(d);
console.log('list:', JSON.stringify(s.list()));
console.log('index:\n' + s.renderIndex());
console.log('content:\n' + s.getContent('demo'));
```
Expected:list 含 demo;index 含 name+description;content 是正文。报告输出,删临时文件。

- [ ] **Step 5: 更新 README + ROADMAP**

`README.md`:
- `@hermes/tools` 工具列表加 `skill_view`;toolset 列表加 `skills`。
- 新增「技能 (Skills)」小节:技能以 `~/.hermes-ts/skills/<name>/SKILL.md`(frontmatter name/description + 正文)存储;启动扫描,索引注入 system prompt;模型用 `skill_view` 读正文。说明创建/编辑(skill_manage)与自改进待后续。
- 「已知限制」更新:只读技能已支持;skill_manage/自改进未实现。
- 顶部「当前状态」可保留 3b 或加一行「技能(只读)✅」。

`docs/ROADMAP.md`:
- 阶段总览表「技能系统」行:标注「技能 a(只读:SkillStore + skill_view + 注入)✅;技能 b(skill_manage + 自改进)⏸️」。
- 在阶段 3 或独立小节记技能 a 已做项(SkillStore/skill_view/skills toolset/系统提示注入/skillsDir)。
- 「已知限制」更新。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(cli)+docs: 注入 SkillStore + 技能a README/ROADMAP 与端到端验证"
```

---

## 完成定义(技能 a DoD)

- [ ] 新测试全绿(skill-store 12 + paths 1 + toolsets 1 + skill_view 3 + system-prompt 3 + loop 1 = 21 新),原 144 无回归
- [ ] `pnpm -r exec tsc --noEmit` 全包干净
- [ ] 手动:list/index/content 验证通过
- [ ] README + ROADMAP 更新(技能 a ✅)
- [ ] 全部提交到 git
