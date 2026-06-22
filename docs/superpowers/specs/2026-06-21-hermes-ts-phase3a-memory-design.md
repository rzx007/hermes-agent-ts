# Hermes Agent TS — 阶段 3a:记忆系统(Memory) 设计

- **日期**: 2026-06-21
- **状态**: 设计阶段
- **源项目**: `D:/code/personal-project/hermes-agent`(tools/memory_tool.py, agent/memory_manager.py)
- **前置**: 阶段 1 / 2 / 2.5 已完成并合并。当前在 `phase3a-memory` 分支,基线 96 测试全绿。

---

## 1. 背景与目标

hermes 的标志性能力是"自进化"——跨会话记住用户与环境。本阶段实现其**记忆文件系统**:agent 用 `memory` 工具主动持久化知识到 `MEMORY.md`(自己的笔记)和 `USER.md`(用户画像),每轮把记忆注入 system prompt,使 agent 跨会话"记得"。

原项目记忆系统庞大(外部 provider/Honcho 辩证建模/向量检索/后台 sync 线程/prefetch 异步预取/FTS5 会话搜索)。本阶段只做**自包含、纯本地、无 DB 改动**的核心。`session_search`(FTS5 跨会话搜索,触及 SessionDB schema)拆为独立的 **阶段 3b**。

---

## 2. 范围

### 2.1 做(MVP,阶段 3a)
- **MemoryStore**:`~/.hermes-ts/memories/MEMORY.md` + `USER.md`,`§` 分隔条目,字数上限(MEMORY 2200 / USER 1375),原子写,`render()` 渲染为系统提示块。
- **`memory` 工具**:`add` / `replace` / `remove`(单操作),超限/未找到/不唯一 → 错误回灌模型。
- **系统提示注入**:每轮把当前 MEMORY/USER 块渲染进 system prompt(无 prefix cache,每轮读当前内容;模型本轮写的下一轮即生效)。
- 模型主动记忆:靠工具 description 引导(对齐原项目,无后台强制)。
- 架构:`ToolContext.memory` + `LoopDeps.memory`(可选,向后兼容,沿用 approval 注入模式)。

### 2.2 明确不做(推迟)
- **`session_search`(FTS5 跨会话搜索)** → 阶段 3b(独立,改 SessionDB schema)。
- 外部 memory provider(Honcho/holographic/mem0 等)、辩证用户建模、向量检索。
- 后台 sync 线程、prefetch 异步预取、冻结快照(prefix cache 优化)。
- 批量原子操作(operations 数组)、外部漂移检测(多进程并发)。
- `/memory` CLI 管理命令(YAGNI)。

### 2.3 向后兼容
`ToolContext.memory` 与 `LoopDeps.memory` 均可选。不注入时:memory 工具返回"不可用",系统提示无记忆块,行为同阶段 2.5。现有 96 测试不受影响。

---

## 3. 文件结构

```
packages/core/src/
  memory-store.ts        (新) MemoryStore
  memory-store.test.ts   (新)
  paths.ts               (改) memoriesDir()
  paths.test.ts          (改) 补 memoriesDir 测试
  index.ts               (改) 导出 memory-store
packages/tools/src/
  builtin/memory.ts       (新) memory 工具
  builtin/memory.test.ts  (新)
  builtin/index.ts        (改) 注册 memory 工具(builtinTools + registerBuiltins)
  toolsets.ts             (改) 加 'memory' toolset;core.includes 加 'memory'
  toolsets.test.ts        (改) 补 memory toolset 测试
  registry.ts             (改) ToolContext 加 memory?: MemoryStore(type-only import from @hermes/core)
packages/agent/src/
  system-prompt.ts        (改) buildSystemPrompt(cwd, memoryBlock?)
  conversation-loop.ts    (改) LoopDeps.memory?; buildSystemPrompt(ctx.cwd, deps.memory?.render())
  conversation-loop.test.ts (改) 补记忆注入测试
apps/cli/src/
  main.ts                 (改) 创建 MemoryStore 放进 deps.memory
  repl.ts                 (改) 每轮 ctx 注入 memory
```

依赖方向不变。MemoryStore 放 `@hermes/core`(与 SessionDB 并列的文件型存储),tools 和 agent 都依赖 core,可共用其类型。

---

## 4. MemoryStore(`packages/core/src/memory-store.ts`)

```ts
export type MemoryTarget = 'memory' | 'user';

export class MemoryStore {
  constructor(dir: string);   // 读入 dir/MEMORY.md, dir/USER.md → 条目数组(目录不存在时建立)
  getEntries(target: MemoryTarget): string[];
  render(): string;                              // 渲染两块供 system prompt;均空 → ''
  add(target: MemoryTarget, content: string): void;
  replace(target: MemoryTarget, oldText: string, content: string): void;
  remove(target: MemoryTarget, oldText: string): void;
}
```

### 4.1 常量与格式
- `DELIM = '\n§\n'`(条目分隔符,对齐原项目)。
- 文件 = 各条目用 DELIM 连接;空文件 = 无条目;文件不存在/读失败 = 空条目(不抛)。
- `MEMORY.md` ↔ target `'memory'`;`USER.md` ↔ target `'user'`。
- `LIMITS = { memory: 2200, user: 1375 }`(字符数)。**字数度量统一定义为** `entries.join(DELIM).length`(即落盘文件的字符长度)。上限校验与 `render()` 中显示的 `[used/limit]` 的 `used` **使用同一度量**,保证显示数 = 强制数。

### 4.2 操作语义
- `add(target, content)`:把 `content`(trim 后非空)作为新条目追加。
- `replace(target, oldText, content)`:在**唯一**包含 `oldText` 子串的条目中,把该条目内的 `oldText` 替换为 `content`(用 split/join 避免 `$` 替换序列问题)。0 个匹配 → throw「未找到」;>1 个匹配 → throw「不唯一」。
- `remove(target, oldText)`:删除**唯一**包含 `oldText` 子串的整条条目。0/多个匹配同上 throw。
- 每次成功操作后:校验新内容总长度 ≤ LIMITS[target],超限 → throw(错误信息列出当前条目,引导模型删旧),**且不落盘**(操作回滚)。校验通过 → 原子写该文件。

### 4.3 持久化
- **原子写**:写入 `<file>.tmp` 再 `renameSync` 覆盖目标(rename 原子)。临时写失败 → throw,原文件不变。
- `render()` 输出(无条目的块省略;块内条目用 `DELIM`=`\n§\n` 原样连接,两块之间用一个空行 `\n\n` 分隔)。`[used/limit]` 的 used = `entries.join(DELIM).length`(同 §4.1 度量)。示例:
  ```
  ════ MEMORY(你的长期笔记)[12/2200] ════
  条目1
  §
  条目2

  ════ USER(用户画像)[4/1375] ════
  条目A
  ```

---

## 5. memory 工具(`packages/tools/src/builtin/memory.ts`)

```ts
export const memoryTool = defineTool({
  name: 'memory',
  description: '保存/更新长期记忆。WHEN:用户表达偏好、纠正、个人信息,或你学到关于其环境/约定/工作流的稳定事实时主动保存。优先级:用户偏好&纠正 > 环境事实 > 流程。target=memory 存你的笔记,user 存用户画像。',
  toolset: 'memory',
  schema: z.object({
    action: z.enum(['add', 'replace', 'remove']),
    target: z.enum(['memory', 'user']),
    content: z.string().optional().describe('add/replace 的内容'),
    oldText: z.string().optional().describe('replace/remove 定位用的子串'),
  }),
  handler: async (args, ctx) => {
    // 1. if (!ctx.memory) return '记忆系统不可用。';
    // 2. 按 action 校验必填:add 需 content;replace 需 oldText + content;remove 需 oldText。缺 → throw。
    // 3. 调 ctx.memory.add/replace/remove。
    // 4. 返回成功提示(如 `已向 memory 添加 1 条记忆`)。
    // 错误(超限/未找到/不唯一/缺参)throw → registry.call 捕获转字符串回灌模型。
  },
});
```
- `toolset: 'memory'`;在 `TOOLSETS` 新增 `memory` 分组(tools: ['memory']),`core.includes` 追加 `'memory'`。
- 在 `builtinTools` 数组 + `registerBuiltins` 逐个注册(沿用约定)。

### 5.1 ToolContext
`registry.ts` 的 `ToolContext` 增加:`memory?: MemoryStore`(`import type { MemoryStore } from '@hermes/core'`)。

---

## 6. 系统提示注入(`packages/agent`)

- `system-prompt.ts`:签名改为 `buildSystemPrompt(cwd: string, memoryBlock?: string): string`。若 `memoryBlock` 非空,在身份/时间/cwd/工具说明之后附加(用清晰分隔标题,如「以下是你的长期记忆:」)。
- `conversation-loop.ts`:`LoopDeps` 增加 `memory?: MemoryStore`;构建首条 system 消息时 `buildSystemPrompt(ctx.cwd, deps.memory?.render())`。
- 同一 MemoryStore 实例:CLI 放进 `deps.memory`(系统提示读)+ 每轮注入 `ctx.memory`(工具写)。模型本轮写入 → 下一轮 `runConversation` 重建 system prompt 时体现(每轮重建,无冻结快照)。
- agent 与具体实现解耦程度:`LoopDeps.memory` 是 `MemoryStore` 类型(来自 core,agent 已依赖 core),loop 只调 `.render()`,不关心内部。

---

## 7. 错误处理

| 情况 | 处理 |
|------|------|
| 工具缺 `ctx.memory` | 返回「记忆系统不可用」字符串(不崩) |
| add 超字数上限 | MemoryStore throw(附当前条目)→ 回灌,模型删旧后重试 |
| replace/remove 未找到 oldText | throw「未找到」→ 回灌 |
| replace/remove oldText 命中多条 | throw「不唯一,请提供更长上下文」→ 回灌 |
| 缺必填参数 | throw 明确错误 → 回灌 |
| MEMORY.md/USER.md 读失败/损坏 | 视为空条目(不崩) |
| 原子写失败 | throw → 回灌;原文件不变 |

原则:工具层错误回灌模型自我纠正;读失败降级为空。

---

## 8. 测试(Vitest)

| 测试 | 覆盖 |
|------|------|
| `memory-store.test.ts` | add 追加并落盘;render 含条目;空 store render 为空;add 超上限 → throw 且不落盘;replace 唯一替换;replace 未找到/多匹配 → throw;remove 删唯一条目;remove 未找到 → throw;新 MemoryStore 从同目录加载后条目仍在;损坏/缺失文件 → 空条目不崩;原子写后文件内容正确 |
| `memory.test.ts`(工具) | add 经工具落盘;缺 content → 错误;replace/remove 经工具;无 ctx.memory → 返回不可用;超限错误回灌 |
| `toolsets.test.ts`(补) | memory toolset 存在;core 含 memory;computeEnabledTools 默认含 memory(已注册时) |
| `system-prompt`(agent 测) | buildSystemPrompt 带 memoryBlock → 含之;不带 → 不含;cwd 仍在 |
| `conversation-loop.test.ts`(补) | 注入 deps.memory 后 system 消息含记忆内容(mock provider 捕获 messages[0]) |

文件测试用 `mkdtempSync` 临时目录,不碰真实 `~/.hermes-ts`。

### 8.1 完成定义(DoD)
- 新测试全绿 + 原 96 无回归 + 全包 `tsc --noEmit` 干净。
- 手动 `pnpm cli`:让模型「记住我喜欢用 pnpm」→ 看到 `⚙ memory(add,...)`;`/exit` 重启后新会话系统提示含该记忆。
- README + ROADMAP 更新(阶段 3a ✅;3b session_search 待做)。

---

## 9. 后续衔接点
- 阶段 3b:`session_search`(FTS5 over SessionDB messages)——加 messages_fts 虚拟表 + session_search 工具。
- 后续可加:批量原子操作、外部漂移检测、prefetch 检索(相关片段而非全量)、外部 provider 架构、冻结快照(若引入 prefix cache)。
