# Hermes TS 阶段 2:Toolsets 分组系统 + 文件/代码工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给已有的 TS 代理加上「工具集分组(Toolsets)」过滤能力,并把文件工具从 read/write 扩展到 `edit_file`/`search_files`/`list_dir`,让 agent 真正能改代码。

**Architecture:** Toolsets 作为 `@hermes/tools` 内独立于 registry 的过滤层(`toolsets.ts`):`TOOLSETS` 映射定义分组与 includes,`resolveToolset` 递归展开,`computeEnabledTools` 结合 config 算出启用工具名集合;CLI 装配时算出 `toolNames` 传入 loop,`registry.getSchemas(toolNames)` 据此过滤暴露给模型的工具。3 个新工具沿用阶段 1 的 `defineTool` 泛型 + 错误抛出由 `registry.call` 回灌的约定。

**Tech Stack:** 沿用阶段 1(Node 20+ / TS strict / pnpm / Vitest / Zod);新增 `fast-glob`(文件枚举与文件名匹配)。

**Spec:** `docs/superpowers/specs/2026-06-21-hermes-ts-phase2-toolsets-file-tools-design.md`

**前置状态:** 阶段 1 已完成并合并。当前在 `phase2-toolsets-file-tools` 分支,基线已实测 **39 测试全绿**(已修复 `paths.test.ts` 对齐 `~/.hermes-ts` 的基线红)。内部包指向源码解析(无需 build 依赖)。工具用 `defineTool` 定义,`registry.call` 捕获工具异常转错误字符串回灌模型。注意:HERMES_HOME 现为 `~/.hermes-ts`(非 `~/.hermes`)。

---

## 文件结构总览

| 文件 | 职责 |
|------|------|
| `packages/tools/src/registry.ts`(改) | 新增 `getToolNames(): string[]` |
| `packages/tools/src/toolsets.ts`(新) | `Toolset` 类型 + `TOOLSETS` + `resolveToolset` + `computeEnabledTools` |
| `packages/tools/src/toolsets.test.ts`(新) | toolsets 单测 |
| `packages/tools/src/builtin/edit-file.ts`(新) | `edit_file` 精确替换 |
| `packages/tools/src/builtin/search-files.ts`(新) | `search_files`(fast-glob) |
| `packages/tools/src/builtin/list-dir.ts`(新) | `list_dir` |
| `packages/tools/src/builtin/edit-file.test.ts` 等(新) | 工具单测 |
| `packages/tools/src/builtin/{read-file,write-file,terminal}.ts`(改) | `toolset` 字段改为 `'file'`/`'file'`/`'terminal'` |
| `packages/tools/src/builtin/index.ts`(改) | 注册 3 个新工具 |
| `packages/tools/src/index.ts`(改) | 导出 toolsets |
| `packages/tools/package.json`(改) | 加 `fast-glob` |
| `packages/core/src/config.ts`(改) | `HermesConfig` + `loadConfig` 加 enabled/disabledToolsets |
| `packages/agent/src/conversation-loop.ts`(改) | `LoopDeps.toolNames?` + `getSchemas(toolNames)` |
| `apps/cli/src/main.ts`(改) | `computeEnabledTools` → `deps.toolNames` |
| `apps/cli/src/repl.ts`(改) | `/tools` 命令 + `/help` |

---

## Task 1:registry 新增 getToolNames + 现有工具 toolset 字段对齐

**Files:**
- Modify: `packages/tools/src/registry.ts`
- Modify: `packages/tools/src/registry.test.ts`
- Modify: `packages/tools/src/builtin/read-file.ts`, `write-file.ts`, `terminal.ts`

- [ ] **Step 1: 写失败测试(getToolNames)**

在 `packages/tools/src/registry.test.ts` 末尾追加(复用已有 `z` 导入):
```ts
test('getToolNames 返回所有已注册工具名', () => {
  const r = new ToolRegistry();
  r.register({ name: 'a', description: 'd', toolset: 'core', schema: z.object({}), handler: async () => 'a' });
  r.register({ name: 'b', description: 'd', toolset: 'core', schema: z.object({}), handler: async () => 'b' });
  expect(r.getToolNames().sort()).toEqual(['a', 'b']);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/tools/src/registry.test.ts`
Expected: FAIL（getToolNames 不存在）

- [ ] **Step 3: 实现 getToolNames**

在 `packages/tools/src/registry.ts` 的 `ToolRegistry` 类中,`has` 方法旁新增:
```ts
  getToolNames(): string[] {
    return [...this.tools.keys()];
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/tools/src/registry.test.ts`
Expected: PASS

- [ ] **Step 5: 对齐现有工具的 toolset 字段**

把三个现有工具的 `toolset` 改为与分组一致(消除与即将引入的 TOOLSETS 映射的漂移):
- `packages/tools/src/builtin/read-file.ts`:`toolset: 'core'` → `toolset: 'file'`
- `packages/tools/src/builtin/write-file.ts`:`toolset: 'core'` → `toolset: 'file'`
- `packages/tools/src/builtin/terminal.ts`:`toolset: 'core'` → `toolset: 'terminal'`

- [ ] **Step 6: 全量测试 + typecheck + 提交**

Run: `pnpm vitest run`(应仍 39 + 1 = 40 通过)
Run: `pnpm --filter @hermes/tools exec tsc --noEmit`(干净)
```bash
git add -A
git commit -m "feat(tools): registry.getToolNames + 现有工具 toolset 字段对齐"
```

---

## Task 2:Toolsets 系统(toolsets.ts)

**Files:**
- Create: `packages/tools/src/toolsets.ts`
- Create: `packages/tools/src/toolsets.test.ts`
- Modify: `packages/tools/src/index.ts`

- [ ] **Step 1: 写失败测试**

`packages/tools/src/toolsets.test.ts`:
```ts
import { test, expect } from 'vitest';
import { resolveToolset, computeEnabledTools, TOOLSETS } from './toolsets.js';

test('TOOLSETS 含 file/terminal/core', () => {
  expect(Object.keys(TOOLSETS)).toEqual(expect.arrayContaining(['file', 'terminal', 'core']));
});

test('resolveToolset 展开叶子分组', () => {
  expect(resolveToolset('terminal')).toEqual(['terminal']);
  expect(resolveToolset('file').sort()).toEqual(['edit_file', 'list_dir', 'read_file', 'search_files', 'write_file']);
});

test('resolveToolset 递归展开 includes(core→file+terminal)', () => {
  const tools = resolveToolset('core').sort();
  expect(tools).toContain('read_file');
  expect(tools).toContain('terminal');
  expect(tools).toContain('edit_file');
});

test("resolveToolset 'all'/'*' 返回所有 toolset 工具并集", () => {
  const all = resolveToolset('all').sort();
  expect(all).toContain('read_file');
  expect(all).toContain('terminal');
  expect(resolveToolset('*').sort()).toEqual(all);
});

test('resolveToolset 未知名返回空数组', () => {
  expect(resolveToolset('nope')).toEqual([]);
});

test('resolveToolset 环依赖不死循环', () => {
  // core 引用 file/terminal,均为叶子,无环;此处验证 visited 机制不会重复/崩溃
  expect(() => resolveToolset('core')).not.toThrow();
});

test('computeEnabledTools 默认(enabled undefined)= 全部已注册', () => {
  const registered = ['read_file', 'terminal', 'unknown_extra'];
  expect(computeEnabledTools({}, registered).sort()).toEqual(['read_file', 'terminal', 'unknown_extra'].sort());
});

test('computeEnabledTools enabled 子集 + 与已注册取交集', () => {
  // file 分组含 5 个工具,但只有部分已注册 → 只返回已注册的
  const registered = ['read_file', 'write_file', 'terminal'];
  const out = computeEnabledTools({ enabled: ['file'] }, registered).sort();
  expect(out).toEqual(['read_file', 'write_file']); // edit_file/search_files/list_dir 未注册被忽略
});

test('computeEnabledTools disabled 相减', () => {
  const registered = ['read_file', 'write_file', 'terminal'];
  const out = computeEnabledTools({ enabled: ['core'], disabled: ['terminal'] }, registered).sort();
  expect(out).toEqual(['read_file', 'write_file']);
});

test('computeEnabledTools 未知 toolset 跳过(不抛)', () => {
  const registered = ['read_file', 'terminal'];
  expect(() => computeEnabledTools({ enabled: ['nope'] }, registered)).not.toThrow();
  expect(computeEnabledTools({ enabled: ['nope'] }, registered)).toEqual([]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/tools/src/toolsets.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 toolsets.ts**

`packages/tools/src/toolsets.ts`:
```ts
export interface Toolset {
  description: string;
  tools?: string[];
  includes?: string[];
}

export const TOOLSETS: Record<string, Toolset> = {
  file: {
    description: '文件读写/编辑/搜索',
    tools: ['read_file', 'write_file', 'edit_file', 'search_files', 'list_dir'],
  },
  terminal: {
    description: '执行 shell 命令',
    tools: ['terminal'],
  },
  core: {
    description: '核心工具集',
    includes: ['file', 'terminal'],
  },
};

// 递归展开 toolset 名 → 工具名数组。支持 'all'/'*';未知名返回 [];visited 做环检测。
export function resolveToolset(name: string, visited: Set<string> = new Set()): string[] {
  if (name === 'all' || name === '*') {
    const acc = new Set<string>();
    // 每个顶层 toolset 用独立 visited 完整展开,避免共享 visited 在未来
    // 「某工具仅经 includes 可达」的形状下被错误跳过
    for (const key of Object.keys(TOOLSETS)) {
      for (const t of resolveToolset(key, new Set())) acc.add(t);
    }
    return [...acc];
  }
  if (visited.has(name)) return [];
  visited.add(name);
  const ts = TOOLSETS[name];
  if (!ts) return [];
  const acc = new Set<string>(ts.tools ?? []);
  for (const inc of ts.includes ?? []) {
    for (const t of resolveToolset(inc, visited)) acc.add(t);
  }
  return [...acc];
}

// 计算最终启用的工具名。
// - enabled undefined → 全部已注册工具
// - 否则 union(resolveToolset(每个 enabled)) 再 difference(resolveToolset(每个 disabled))
// - 末尾与 registeredToolNames 取交集(未注册的工具忽略 → 前向兼容)
// - 未知 toolset 名通过 resolveToolset 返回 [] 被自然跳过(可选 logger 警告)
export function computeEnabledTools(
  opts: { enabled?: string[]; disabled?: string[] },
  registeredToolNames: string[],
): string[] {
  const registered = new Set(registeredToolNames);
  let selected: Set<string>;
  if (opts.enabled === undefined) {
    selected = new Set(registeredToolNames);
  } else {
    selected = new Set<string>();
    for (const name of opts.enabled) {
      for (const t of resolveToolset(name)) selected.add(t);
    }
  }
  for (const name of opts.disabled ?? []) {
    for (const t of resolveToolset(name)) selected.delete(t);
  }
  return [...selected].filter((t) => registered.has(t));
}
```

> 说明:`computeEnabledTools` 不直接接 logger(保持纯函数易测);未知 toolset 经 `resolveToolset` 返回 `[]` 自然跳过。CLI 层可在装配时对配置里的未知 toolset 名做一次 warning(见 Task 6,可选)。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/tools/src/toolsets.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: 导出 + 提交**

在 `packages/tools/src/index.ts` 追加:
```ts
export * from './toolsets.js';
```
Run: `pnpm --filter @hermes/tools exec tsc --noEmit`(干净)
Run: `pnpm vitest run`(40 + 10 = 50 通过)
```bash
git add -A
git commit -m "feat(tools): Toolsets 分组系统(resolveToolset + computeEnabledTools)"
```

---

## Task 3:edit_file 工具

**Files:**
- Create: `packages/tools/src/builtin/edit-file.ts`
- Create: `packages/tools/src/builtin/edit-file.test.ts`

- [ ] **Step 1: 写失败测试**

`packages/tools/src/builtin/edit-file.test.ts`:
```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editFileTool } from './edit-file.js';
import { createLogger } from '@hermes/core';

let dir: string;
const ctx = () => ({ cwd: dir, logger: createLogger('test') });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hermes-edit-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('唯一匹配替换成功', async () => {
  writeFileSync(join(dir, 'a.txt'), 'hello world');
  const out = await editFileTool.handler({ path: 'a.txt', oldString: 'world', newString: 'there' }, ctx());
  expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('hello there');
  expect(out).toContain('1');
});

test('未找到 oldString 抛错', async () => {
  writeFileSync(join(dir, 'a.txt'), 'hello');
  await expect(editFileTool.handler({ path: 'a.txt', oldString: 'xyz', newString: 'q' }, ctx())).rejects.toThrow();
});

test('oldString 不唯一且未设 replaceAll 抛错', async () => {
  writeFileSync(join(dir, 'a.txt'), 'a a a');
  await expect(editFileTool.handler({ path: 'a.txt', oldString: 'a', newString: 'b' }, ctx())).rejects.toThrow();
});

test('replaceAll 替换全部', async () => {
  writeFileSync(join(dir, 'a.txt'), 'a a a');
  const out = await editFileTool.handler({ path: 'a.txt', oldString: 'a', newString: 'b', replaceAll: true }, ctx());
  expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('b b b');
  expect(out).toContain('3');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/tools/src/builtin/edit-file.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 edit-file.ts**

`packages/tools/src/builtin/edit-file.ts`:
```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../registry.js';

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export const editFileTool = defineTool({
  name: 'edit_file',
  description: '精确字符串替换编辑文件。oldString 必须在文件中唯一(或设 replaceAll)。',
  toolset: 'file',
  schema: z.object({
    path: z.string(),
    oldString: z.string().describe('要被替换的精确文本'),
    newString: z.string().describe('替换后的文本'),
    replaceAll: z.boolean().optional().describe('替换全部匹配,默认 false'),
  }),
  handler: async ({ path, oldString, newString, replaceAll }, ctx) => {
    const full = resolve(ctx.cwd, path);
    const content = readFileSync(full, 'utf8');
    const n = countOccurrences(content, oldString);
    if (n === 0) {
      throw new Error(`未找到 oldString,无法替换。请确认文本(含空白)与文件内容完全一致。`);
    }
    if (n > 1 && !replaceAll) {
      throw new Error(`oldString 不唯一(出现 ${n} 处)。请提供更长的上下文使其唯一,或设 replaceAll: true。`);
    }
    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);
    writeFileSync(full, updated, 'utf8');
    return `已在 ${path} 替换 ${replaceAll ? n : 1} 处`;
  },
});
```

> 注:`content.replace(oldString, newString)` 在 oldString 为普通字符串时只替换第一处且不解释正则(字符串参数不当作正则),配合 n===1 的前置检查即「替换唯一一处」。`replaceAll` 用 `split/join` 避免 `$` 等特殊替换序列问题。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/tools/src/builtin/edit-file.test.ts`
Expected: PASS（4 个）

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(tools): edit_file 精确替换工具"
```

---

## Task 4:search_files 工具(fast-glob)

**Files:**
- Modify: `packages/tools/package.json`(加 fast-glob)
- Create: `packages/tools/src/builtin/search-files.ts`
- Create: `packages/tools/src/builtin/search-files.test.ts`

- [ ] **Step 1: 加依赖**

在 `packages/tools/package.json` 的 `dependencies` 加:
```
"fast-glob": "^3.3.0"
```
Run（repo root）: `pnpm install`

- [ ] **Step 2: 写失败测试**

`packages/tools/src/builtin/search-files.test.ts`:
```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchFilesTool } from './search-files.js';
import { createLogger } from '@hermes/core';

let dir: string;
const ctx = () => ({ cwd: dir, logger: createLogger('test') });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-search-'));
  writeFileSync(join(dir, 'a.ts'), 'const foo = 1;\nconst bar = 2;');
  writeFileSync(join(dir, 'b.txt'), 'foo appears here');
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'c.ts'), 'foo in node_modules');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('content 模式返回 路径:行号: 匹配行', async () => {
  const out = await searchFilesTool.handler({ pattern: 'foo' }, ctx());
  expect(out).toContain('a.ts');
  expect(out).toMatch(/a\.ts:1:/);
  expect(out).toContain('foo');
});

test('content 模式忽略 node_modules', async () => {
  const out = await searchFilesTool.handler({ pattern: 'foo' }, ctx());
  expect(out).not.toContain('node_modules');
});

test('content 模式 glob 限定文件范围', async () => {
  const out = await searchFilesTool.handler({ pattern: 'foo', glob: '**/*.ts' }, ctx());
  expect(out).toContain('a.ts');
  expect(out).not.toContain('b.txt');
});

test('filename 模式返回路径列表', async () => {
  const out = await searchFilesTool.handler({ pattern: '**/*.ts', mode: 'filename' }, ctx());
  expect(out).toContain('a.ts');
  expect(out).not.toContain('b.txt');
});

test('无匹配返回提示', async () => {
  const out = await searchFilesTool.handler({ pattern: 'zzzznomatch_xyzqq' }, ctx());
  expect(out).toContain('无匹配');
});

test('无效正则抛错', async () => {
  await expect(searchFilesTool.handler({ pattern: '(' }, ctx())).rejects.toThrow();
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm vitest run packages/tools/src/builtin/search-files.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现 search-files.ts**

`packages/tools/src/builtin/search-files.ts`:
```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fg from 'fast-glob';
import { z } from 'zod';
import { defineTool } from '../registry.js';

const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**'];
const MAX_MATCHES = 200;
const MAX_BYTES = 50 * 1024;

export const searchFilesTool = defineTool({
  name: 'search_files',
  description: '搜索文件。content 模式:按正则搜内容,返回 路径:行号: 匹配行。filename 模式:按 glob 搜文件名。',
  toolset: 'file',
  schema: z.object({
    pattern: z.string().describe('content 模式=正则;filename 模式=glob 或子串'),
    path: z.string().optional().describe('搜索根目录,默认 cwd'),
    mode: z.enum(['content', 'filename']).optional().describe('默认 content'),
    glob: z.string().optional().describe('content 模式下限定文件范围,如 **/*.ts'),
  }),
  handler: async ({ pattern, path, mode = 'content', glob }, ctx) => {
    const root = resolve(ctx.cwd, path ?? '.');

    if (mode === 'filename') {
      const files = await fg(pattern, { cwd: root, ignore: IGNORE, dot: false });
      if (files.length === 0) return '无匹配';
      const shown = files.slice(0, MAX_MATCHES);
      const suffix = files.length > shown.length ? `\n... [共 ${files.length} 个,已截断]` : '';
      return shown.join('\n') + suffix;
    }

    // content 模式
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (e) {
      throw new Error(`无效正则: ${(e as Error).message}`);
    }
    const files = await fg(glob ?? '**/*', { cwd: root, ignore: IGNORE, dot: false, onlyFiles: true });
    const lines: string[] = [];
    let bytes = 0;
    let truncated = false;
    for (const rel of files) {
      let text: string;
      try {
        text = readFileSync(resolve(root, rel), 'utf8');
      } catch {
        continue; // 二进制/不可读跳过
      }
      const fileLines = text.split('\n');
      for (let i = 0; i < fileLines.length; i++) {
        if (regex.test(fileLines[i]!)) {
          const entry = `${rel}:${i + 1}: ${fileLines[i]!.trim()}`;
          if (lines.length >= MAX_MATCHES || bytes + entry.length > MAX_BYTES) {
            truncated = true;
            break;
          }
          lines.push(entry);
          bytes += entry.length;
        }
      }
      if (truncated) break;
    }
    if (lines.length === 0) return '无匹配';
    return lines.join('\n') + (truncated ? '\n... [结果过多,已截断]' : '');
  },
});
```

> 注:`fast-glob` 默认导出为 `fg`。`regex.test` 在全局标志下会有 lastIndex 副作用,但这里 `new RegExp(pattern)` 不带 g 标志,逐行 test 安全。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run packages/tools/src/builtin/search-files.test.ts`
Expected: PASS（6 个）

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(tools): search_files 工具(fast-glob content/filename 双模式)"
```

---

## Task 5:list_dir 工具 + 注册 3 个新工具

**Files:**
- Create: `packages/tools/src/builtin/list-dir.ts`
- Create: `packages/tools/src/builtin/list-dir.test.ts`
- Modify: `packages/tools/src/builtin/index.ts`

- [ ] **Step 1: 写失败测试**

`packages/tools/src/builtin/list-dir.test.ts`:
```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDirTool } from './list-dir.js';
import { createLogger } from '@hermes/core';

let dir: string;
const ctx = () => ({ cwd: dir, logger: createLogger('test') });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-ls-'));
  writeFileSync(join(dir, 'file.txt'), 'x');
  mkdirSync(join(dir, 'sub'));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('列出条目,目录带尾随 /', async () => {
  const out = await listDirTool.handler({}, ctx());
  expect(out).toContain('file.txt');
  expect(out).toContain('sub/');
});

test('指定子路径', async () => {
  writeFileSync(join(dir, 'sub', 'inner.txt'), 'y');
  const out = await listDirTool.handler({ path: 'sub' }, ctx());
  expect(out).toContain('inner.txt');
});

test('路径不存在抛错', async () => {
  await expect(listDirTool.handler({ path: 'nope' }, ctx())).rejects.toThrow();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/tools/src/builtin/list-dir.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 list-dir.ts**

`packages/tools/src/builtin/list-dir.ts`:
```ts
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../registry.js';

export const listDirTool = defineTool({
  name: 'list_dir',
  description: '列出目录的直接条目(不递归)。目录名以 / 结尾。',
  toolset: 'file',
  schema: z.object({ path: z.string().optional().describe('默认 cwd') }),
  handler: async ({ path }, ctx) => {
    const dir = resolve(ctx.cwd, path ?? '.');
    const entries = readdirSync(dir, { withFileTypes: true });
    const names = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return names.length ? names.join('\n') : '(空目录)';
  },
});
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/tools/src/builtin/list-dir.test.ts`
Expected: PASS（3 个）

- [ ] **Step 5: 注册 3 个新工具**

修改 `packages/tools/src/builtin/index.ts`,导入并加入 `builtinTools` 数组 + `registerBuiltins` 的逐个 register(沿用现有逐个注册写法):
```ts
import type { ToolRegistry } from '../registry.js';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { terminalTool } from './terminal.js';
import { editFileTool } from './edit-file.js';
import { searchFilesTool } from './search-files.js';
import { listDirTool } from './list-dir.js';

export const builtinTools = [
  readFileTool, writeFileTool, terminalTool,
  editFileTool, searchFilesTool, listDirTool,
];

export function registerBuiltins(registry: ToolRegistry): void {
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(terminalTool);
  registry.register(editFileTool);
  registry.register(searchFilesTool);
  registry.register(listDirTool);
}
```

- [ ] **Step 6: 全量测试 + typecheck + 提交**

Run: `pnpm vitest run`（应 50 + 4 + 6 + 3 = 63 通过）
Run: `pnpm --filter @hermes/tools exec tsc --noEmit`（干净）
```bash
git add -A
git commit -m "feat(tools): list_dir 工具 + 注册 edit_file/search_files/list_dir"
```

---

## Task 6:config 接线(enabled/disabledToolsets)

**Files:**
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/config` 的测试（如无则在 core 新建 `config.test.ts`）

- [ ] **Step 1: 写失败测试**

`packages/core/src/config.test.ts`（新建;若已存在则追加）:
```ts
import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';

// 用一个不存在 config.yaml 的临时 HERMES_HOME,确保测试不读到用户真实配置(hermetic)
const HOME = () => ({ HERMES_HOME: mkdtempSync(join(tmpdir(), 'hermes-cfg-')) });

test('loadConfig 解析 HERMES_ENABLED/DISABLED_TOOLSETS 逗号分隔', () => {
  const c = loadConfig({
    ...HOME(),
    GLM_API_KEY: 'k',
    HERMES_ENABLED_TOOLSETS: 'file, terminal',
    HERMES_DISABLED_TOOLSETS: 'terminal',
  } as NodeJS.ProcessEnv);
  expect(c.enabledToolsets).toEqual(['file', 'terminal']);
  expect(c.disabledToolsets).toEqual(['terminal']);
});

test('loadConfig 未设置时 toolsets 为 undefined', () => {
  const c = loadConfig({ ...HOME(), GLM_API_KEY: 'k' } as NodeJS.ProcessEnv);
  expect(c.enabledToolsets).toBeUndefined();
  expect(c.disabledToolsets).toBeUndefined();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/core/src/config.test.ts`
Expected: FAIL

- [ ] **Step 3: 改 config.ts**

在 `HermesConfig` 接口加:
```ts
  enabledToolsets?: string[];
  disabledToolsets?: string[];
```
在 `loadConfig` 的 return 对象里加一个解析助手(放在函数内或模块内):
```ts
  const parseList = (v: string | undefined, fileVal: unknown): string[] | undefined => {
    if (v !== undefined && v.trim() !== '') return v.split(',').map((s) => s.trim()).filter(Boolean);
    if (Array.isArray(fileVal)) return (fileVal as unknown[]).map(String);
    return undefined;
  };
```
并在 return 中加:
```ts
    enabledToolsets: parseList(env.HERMES_ENABLED_TOOLSETS, fromFile.enabledToolsets),
    disabledToolsets: parseList(env.HERMES_DISABLED_TOOLSETS, fromFile.disabledToolsets),
```
（`fromFile` 是已有的 yaml 解析对象;若其类型为 `Record<string, any>` 则直接可用。）

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/core/src/config.test.ts`
Expected: PASS

- [ ] **Step 5: 全量测试 + typecheck + 提交**

Run: `pnpm vitest run`（63 + 2 = 65 通过）
Run: `pnpm --filter @hermes/core exec tsc --noEmit`（干净）
```bash
git add -A
git commit -m "feat(core): config 增加 enabled/disabledToolsets"
```

---

## Task 7:agent loop 按 toolNames 过滤

**Files:**
- Modify: `packages/agent/src/conversation-loop.ts`
- Modify: `packages/agent/src/conversation-loop.test.ts`

- [ ] **Step 1: 写失败测试(toolNames 过滤)**

在 `packages/agent/src/conversation-loop.test.ts` 追加。利用现有 `scriptedProvider`/`makeDeps`。需要断言传给 provider 的 tools 受 toolNames 限制——最简单做法:用一个能捕获 tools 的 mock provider。新增:
```ts
test('toolNames 限定暴露给 provider 的工具', async () => {
  const seen: string[][] = [];
  const provider: Provider = {
    name: 'mock',
    async *complete(req) { seen.push((req.tools ?? []).map((t) => t.name)); yield { contentDelta: 'ok' }; },
    async aggregate(): Promise<CompletionResult> { return { content: 'ok', toolCalls: [], finishReason: 'stop' }; },
  };
  const { db, deps } = makeDeps(provider);
  // makeDeps 注册了 read_file;再注册一个 terminal 以便区分
  deps.registry.register({ name: 'terminal', description: 't', toolset: 'terminal', schema: z.object({}), handler: async () => 'x' });
  // 用展开构造带 toolNames 的新 deps(makeDeps 返回的是 inferred 字面量,不能直接赋 toolNames)
  const filtered = { ...deps, toolNames: ['read_file'] }; // 只暴露 read_file
  const s = db.createSession();
  for await (const _ of runConversation(filtered, s.id, 'hi', { cwd: '/', logger: createLogger('t') })) { /* drain */ }
  expect(seen[0]).toEqual(['read_file']);
});
```
（注:不要写 `deps.toolNames = ...` —— `makeDeps` 返回的 `deps` 是 inferred 字面量类型,没有 `toolNames` 属性,直接赋值会 `tsc` 报错。用 `{ ...deps, toolNames: [...] }` 新建对象,其类型含 `toolNames` 且满足 `LoopDeps`。在 Step 3 给 `LoopDeps` 加上 `toolNames?` 后,`runConversation(filtered, ...)` 即通过。Step 2 的红来自:Step 3 尚未实现过滤,`seen[0]` 仍是全部工具名 → 断言失败。)

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/agent/src/conversation-loop.test.ts`
Expected: FAIL（`toolNames` 不在 LoopDeps 上 / 断言失败）

- [ ] **Step 3: 改 conversation-loop.ts**

在 `LoopDeps` 接口加:
```ts
  toolNames?: string[];
```
把:
```ts
  const tools = registry.getSchemas();
```
改为:
```ts
  const tools = registry.getSchemas(deps.toolNames);
```
（`deps` 已在函数内解构;若当前是 `const { db, provider, registry, model, maxIterations } = deps;`,新增对 `toolNames` 的使用用 `deps.toolNames` 即可,或加入解构。)

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/agent/src/conversation-loop.test.ts`
Expected: PASS（原 6 + 1 = 7）

- [ ] **Step 5: 全量测试 + typecheck + 提交**

Run: `pnpm vitest run`（65 + 1 = 66 通过）
Run: `pnpm --filter @hermes/agent exec tsc --noEmit`（干净）
```bash
git add -A
git commit -m "feat(agent): loop 按 toolNames 过滤暴露工具"
```

---

## Task 8:CLI 接线(computeEnabledTools + /tools 命令)

**Files:**
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/repl.ts`

- [ ] **Step 1: 改 main.ts**

`apps/cli/src/main.ts`:导入 `computeEnabledTools`,在 `registerBuiltins(registry)` 后计算 toolNames 并放进 deps:
```ts
import { ToolRegistry, registerBuiltins, computeEnabledTools } from '@hermes/tools';
...
  const registry = new ToolRegistry();
  registerBuiltins(registry);
  const toolNames = computeEnabledTools(
    { enabled: config.enabledToolsets, disabled: config.disabledToolsets },
    registry.getToolNames(),
  );

  const deps = { db, provider, registry, model: config.model, maxIterations: config.maxIterations, toolNames };
```
（可选:若 `config.enabledToolsets`/`disabledToolsets` 含 TOOLSETS 里不存在的名字,用 `createLogger` 打一条 warning。非必须。)

- [ ] **Step 2: 改 repl.ts 加 /tools 命令**

`apps/cli/src/repl.ts`:在斜杠命令分支里(`/help` 旁)加:
```ts
    if (line === '/tools') {
      const names = deps.toolNames ?? deps.registry.getToolNames();
      console.log(pc.dim(`启用的工具(${names.length}):`));
      console.log(names.join(', '));
      continue;
    }
```
并把 `/help` 的提示文本补上 `/tools`,例如:
```ts
    if (line === '/help') { console.log('/new 新会话  /tools 查看启用工具  /exit 退出  /help 帮助'); continue; }
```
（`deps` 已是 `repl` 的参数;`deps.registry` 与 `deps.toolNames` 均可用。）

- [ ] **Step 3: typecheck + 冒烟 + 提交**

Run: `pnpm --filter @hermes/cli exec tsc --noEmit`（干净）
Run（无 key 冒烟,确认装配仍可加载）: `GLM_API_KEY= pnpm --filter @hermes/cli exec tsx src/main.ts`
Expected: 打印「缺少 API Key」并退出 1（证明接线无导入错误）
Run 全量: `pnpm vitest run`（66 仍全绿,CLI 无新单测）
```bash
git add -A
git commit -m "feat(cli): computeEnabledTools 接线 + /tools 命令"
```

---

## Task 9:端到端验证 + README 更新

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 全量类型检查 + 测试**

Run: `pnpm -r exec tsc --noEmit`（全包干净）
Run: `pnpm vitest run`（66 全绿）

- [ ] **Step 2: 手动验证 toolset 过滤(无需 API key)**

由于无 key 无法真对话,用一个临时脚本验证过滤生效(或在 Task 8 冒烟基础上加一行打印)。可在 repo root 跑:
```bash
node --import tsx -e "import('@hermes/tools').then(m=>{const r=new m.ToolRegistry();m.registerBuiltins(r);console.log('all:',r.getToolNames().sort().join(','));console.log('disable terminal:',m.computeEnabledTools({disabled:['terminal']},r.getToolNames()).sort().join(','));})"
```
Expected:`all` 含 6 个工具;`disable terminal` 不含 `terminal`。
（若 `--import tsx` 写法不便,可临时写 `apps/cli/src/_smoke.ts` 跑后删除;此步只为人工确认,不入库。)

- [ ] **Step 3: 更新 README**

在 `README.md` 的「当前状态」与工具列表处,加入阶段 2 内容:
- `@hermes/tools` 描述补:Toolsets 分组(file/terminal/core)+ 工具 `edit_file`/`search_files`/`list_dir`
- 新增「工具集配置」小节:说明 `HERMES_ENABLED_TOOLSETS` / `HERMES_DISABLED_TOOLSETS`(逗号分隔)与 `/tools` 命令
- 路线图把阶段 2 标为 ✅

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "docs: 阶段2 README 与端到端验证"
```

---

## 完成定义(阶段 2 DoD)

- [ ] 新增测试全绿(toolsets 10 + edit 4 + search 6 + list 3 + registry 1 + config 2 + loop 1 = 27 新),原 39 无回归,共约 66 测试
- [ ] `pnpm -r exec tsc --noEmit` 全包干净
- [ ] 手动验证:`computeEnabledTools({disabled:['terminal']})` 时 terminal 工具消失;`/tools` 列出启用工具
- [ ] README 更新,阶段 2 标记完成
- [ ] 全部提交到 git
