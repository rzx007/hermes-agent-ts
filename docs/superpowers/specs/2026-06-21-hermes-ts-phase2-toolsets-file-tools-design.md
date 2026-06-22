# Hermes Agent TS — 阶段 2:Toolsets 分组系统 + 文件/代码工具 设计

- **日期**: 2026-06-21
- **状态**: 设计阶段
- **源项目**: `D:/code/personal-project/hermes-agent`（toolsets.py / model_tools.py / file_tools.py）
- **前置**: 阶段 1（核心代理 MVP）已完成并合并到 main

---

## 1. 背景与目标

### 1.1 总体定位
用 TypeScript 完整复刻 hermes-agent，分阶段推进，保真度为「架构级对齐 + 惯用 TS 重写」。阶段 1 已交付核心代理（SessionDB / Provider / ToolRegistry / ConversationLoop / 3 工具 / CLI）。

### 1.2 阶段 2 范围
原项目「工具系统」部分体量大（Toolsets 分组、~65 个工具、Terminal 多后端、命令审批），需进一步拆解。本阶段只做两块、且均为**纯本地、零外部服务依赖**：

- **A. Toolsets 分组系统** —— 工具分组定义、递归展开、enabled/disabled 过滤，接入 registry 与 config/CLI
- **B. 文件/代码工具扩展** —— 新增 `edit_file`、`search_files`、`list_dir`，让 agent 真正能改代码

### 1.3 明确不做（留作后续独立小阶段）
- Web 工具（web_search/web_extract，需搜索 API key）
- Terminal 后端抽象与 docker/ssh 等远程后端
- 命令审批/白名单（安全模块）
- vision/browser/image_gen 等重型或外部依赖工具

### 1.4 唯一新增依赖
`fast-glob`（文件枚举与文件名匹配）。其余沿用阶段 1 技术栈。

---

## 2. 文件结构

```
packages/tools/
  src/
    toolsets.ts            (新) TOOLSETS 定义 + resolveToolset + computeEnabledTools
    toolsets.test.ts       (新)
    registry.ts            (改) 新增 getToolNames(): string[]
    builtin/
      edit-file.ts         (新) edit_file 工具
      search-files.ts      (新) search_files 工具（fast-glob）
      list-dir.ts          (新) list_dir 工具
      edit-file.test.ts    (新)
      search-files.test.ts (新)
      list-dir.test.ts     (新)
      index.ts             (改) builtinTools + registerBuiltins 加入 3 个新工具
    index.ts               (改) 导出 toolsets
  package.json             (改) 加 fast-glob 依赖
packages/core/src/config.ts          (改) HermesConfig + loadConfig 加 enabledToolsets/disabledToolsets
packages/agent/src/conversation-loop.ts (改) LoopDeps 加 toolNames?; getSchemas(toolNames) 过滤
apps/cli/src/main.ts       (改) computeEnabledTools → deps.toolNames
apps/cli/src/repl.ts       (改) /tools 命令 + /help 文本
```

依赖方向不变：`core ← providers ← agent ← cli`，`tools ← agent`。

---

## 3. Toolsets 分组系统（`packages/tools/src/toolsets.ts`）

```ts
interface Toolset {
  description: string;
  tools?: string[];
  includes?: string[];
}

export const TOOLSETS: Record<string, Toolset> = {
  file:     { description: '文件读写/编辑/搜索', tools: ['read_file', 'write_file', 'edit_file', 'search_files', 'list_dir'] },
  terminal: { description: '执行 shell 命令',     tools: ['terminal'] },
  core:     { description: '核心工具集',          includes: ['file', 'terminal'] },
  // 后续阶段在此追加 web / vision / browser ...
};

// 递归展开 toolset 名 → 工具名列表；支持 'all'/'*'；用 visited 集合做环检测
export function resolveToolset(name: string, visited?: Set<string>): string[];

// 计算最终启用的工具名：
//   enabled 为 undefined → 默认全部已注册工具
//   否则 union(resolveToolset(每个 enabled)) 再 difference(resolveToolset(每个 disabled))
//   最后与 registeredToolNames 取交集（toolset 里列了但未注册的工具自动忽略 → 前向兼容）
export function computeEnabledTools(
  opts: { enabled?: string[]; disabled?: string[] },
  registeredToolNames: string[],
): string[];
```

### 3.1 关键设计点
- `enabled === undefined` → 返回全部已注册工具，**与阶段 1 行为一致**，不破坏现状。
- `computeEnabledTools` 末尾与已注册工具名取交集：toolset 可提前声明未来工具（如 `web_search`），现在静默忽略，不报错。
- 未知 toolset 名：经 logger 打 warning 并跳过（对应原项目 `validate_toolset`），不抛错。
- 环依赖：`resolveToolset` 用 `visited` 集合静默跳过已访问节点。
- `resolveToolset('all')` / `'*'` → 所有 toolset 工具的并集。
- `resolveToolset` 遇未知名：返回 `[]`（由 `computeEnabledTools` 负责 warning），保持函数纯粹、可测。

### 3.2 registry 配套改动
`ToolRegistry` 新增 `getToolNames(): string[]`（返回已注册工具名），供 `computeEnabledTools` 取交集。registry 其余不变。

### 3.3 与 `ToolDef.toolset` 字段的关系（消除双重真相源）
现状：每个工具的 `ToolDef` 都有 `toolset: string` 字段，阶段 1 全部填的 `'core'`。本阶段引入 `TOOLSETS` 映射后，会出现两处声明分组的地方。明确规则：

- **`TOOLSETS` 映射是分组解析（resolveToolset / computeEnabledTools）的唯一权威来源。**
- 每个工具的 `ToolDef.toolset` 字段降级为**信息性字段**（保留，供未来反向查找 tool→toolset，对应原项目 `TOOL_TO_TOOLSET_MAP`），不参与本阶段的过滤逻辑。
- 为消除漂移，本阶段把现有工具的 `toolset` 字段改为与映射中的归属一致：`read_file`/`write_file` → `'file'`，`terminal` → `'terminal'`；新工具 `edit_file`/`search_files`/`list_dir` → `'file'`。这样两处声明语义一致，不矛盾。

---

## 4. 配置接线（`packages/core/src/config.ts`）

`HermesConfig` 增加两个可选字段（默认 `undefined` = 全部启用）：
```ts
enabledToolsets?: string[];
disabledToolsets?: string[];
```

`loadConfig`：
- `HERMES_ENABLED_TOOLSETS` / `HERMES_DISABLED_TOOLSETS`（逗号分隔字符串）或 yaml 字段读取。
- 解析为 `string[]`；未设置则保持 `undefined`。
- env 优先于 yaml（与现有字段一致）。

---

## 5. 三个新工具（`packages/tools/src/builtin/`）

均用 `defineTool` 泛型定义（精确 args 推断，无 `as` 转换）；错误一律 `throw`，由 `ToolRegistry.call` 捕获转为错误字符串回灌模型。

### 5.1 `edit_file` —— 精确字符串替换
```ts
schema: z.object({
  path: z.string(),
  oldString: z.string().describe('要被替换的精确文本'),
  newString: z.string().describe('替换后的文本'),
  replaceAll: z.boolean().optional().describe('替换全部匹配，默认 false'),
})
```
行为：
1. `resolve(ctx.cwd, path)` → `readFileSync`。
2. 统计 `oldString` 出现次数 `n`。
3. `n === 0` → `throw Error('未找到 oldString...')`。
4. `n > 1 && !replaceAll` → `throw Error('oldString 不唯一（n 处），请提供更长上下文或设 replaceAll')`。
5. 否则替换（全部或唯一一处）→ `writeFileSync` → 返回 `已在 path 替换 N 处`。

> 设计取舍：精确匹配（非模糊/diff）——实现确定、失败可回灌让模型纠正，符合 Claude Code Edit 工具的成熟做法。

### 5.2 `search_files` —— 基于 `fast-glob`
```ts
schema: z.object({
  pattern: z.string().describe('content 模式=正则；filename 模式=glob 或子串'),
  path: z.string().optional().describe('搜索根目录，默认 cwd'),
  mode: z.enum(['content', 'filename']).optional().describe('默认 content'),
  glob: z.string().optional().describe('content 模式下限定文件范围，如 **/*.ts'),
})
```
行为：
- **content（默认）**：`fast-glob`(`glob ?? '**/*'`，`cwd`，`ignore: ['**/node_modules/**','**/.git/**','**/dist/**']`，`dot:false`) 枚举文件 → 逐文件 `readFileSync` → 用 `new RegExp(pattern)` 逐行匹配 → 收集 `相对路径:行号: 匹配行`。
  - 结果上限：最多 200 条匹配 或 总输出 ~50KB，超出截断并注明。
  - 无效正则 → `throw`。
- **filename**：`fast-glob`(`pattern` 作为 glob，同 ignore) → 返回相对路径列表（同样上限截断）。
- 无匹配 → 返回 `无匹配` 提示文本（不报错）。

### 5.3 `list_dir` —— 列目录（不递归）
```ts
schema: z.object({ path: z.string().optional().describe('默认 cwd') })
```
行为：`resolve(ctx.cwd, path ?? '.')` → `readdirSync(dir, { withFileTypes: true })` → 目录名加尾随 `/` → 排序 → 逐行返回。路径不存在 → fs 抛错（被 registry 捕获）。

三个新工具的 `ToolDef.toolset` 字段均填 `'file'`（与第 3.3 节规则一致）。

### 5.4 注册
三者加入第 3 节 `file` toolset；在 `builtin/index.ts` 的 `builtinTools` 数组与 `registerBuiltins` 中逐个 `registry.register`（沿用阶段 1 因 `ToolDef<T>` 不变性而逐个注册的约定）。

---

## 6. Agent 与 CLI 接线

### 6.1 `conversation-loop.ts`
- `LoopDeps` 增加 `toolNames?: string[]`。
- `const tools = registry.getSchemas(deps.toolNames)`；`undefined` 时 `getSchemas` 返回全部（阶段 1 行为不变）。

### 6.2 `apps/cli/src/main.ts`
- `registerBuiltins(registry)` 后：
  ```ts
  const toolNames = computeEnabledTools(
    { enabled: config.enabledToolsets, disabled: config.disabledToolsets },
    registry.getToolNames(),
  );
  ```
- `deps` 增加 `toolNames`。

### 6.3 `apps/cli/src/repl.ts`
- 新增 `/tools` 命令：打印当前启用的工具名。实现方式钉死为——`repl` 已持有 `deps`，直接用 `deps.toolNames ?? deps.registry.getToolNames()` 取启用列表打印（不额外加参数）。
- `/help` 文本补 `/tools`。

---

## 7. 错误处理

| 来源 | 策略 |
|------|------|
| 未知 toolset 名 | `computeEnabledTools` 经 logger 打 warning 并跳过，不崩溃 |
| toolset 环依赖 | `resolveToolset` 的 visited 集合静默跳过 |
| `edit_file` 未找到 / 不唯一 | `throw` → `registry.call` 转错误字符串回灌模型 |
| `search_files` 无效正则 | `throw` → 错误字符串；结果过大 → 截断 + 注明（不报错） |
| `list_dir` 路径不存在 | fs 抛错 → `registry.call` 捕获转字符串 |

原则不变：工具层错误回灌模型自我纠正；仅配置层（未知 toolset）走 warning-skip。

---

## 8. 测试策略（Vitest，就近 `*.test.ts`）

| 测试 | 覆盖 |
|------|------|
| `toolsets.test.ts` | resolveToolset：简单展开、includes 嵌套（core→file+terminal）、'all'、环检测、未知名返回 []；computeEnabledTools：默认=全部、enabled 子集、disabled 相减、与已注册取交集（忽略未实现工具）、未知 toolset 跳过 |
| `edit-file.test.ts` | 唯一替换成功、未找到报错、不唯一报错、replaceAll 多处替换 |
| `search-files.test.ts` | content 返回 file:line、filename 返回路径、glob 限定、无匹配提示、忽略 node_modules |
| `list-dir.test.ts` | 列出条目、目录带尾随 /、默认 cwd |
| `registry.test.ts`（补） | `getToolNames()` 返回已注册名 |

### 8.1 完成定义（阶段 2 DoD）
- 新增测试全绿 + 原 39 测试无回归 + 全包 `tsc --noEmit` 干净。
- 手动 `pnpm cli`：`/tools` 列出启用工具；`HERMES_DISABLED_TOOLSETS=terminal pnpm cli` 时 terminal 工具从启用列表消失（且模型拿不到该工具定义）。

---

## 9. 后续阶段衔接点
- `TOOLSETS` 预留 web / vision / browser / image_gen 等分组位（后续阶段填工具即注册即生效）。
- `computeEnabledTools` 的「与已注册取交集」机制使未来工具可提前声明在 toolset 中。
- Terminal 后端抽象（docker/ssh）、命令审批、Web 工具各作为独立后续阶段。
