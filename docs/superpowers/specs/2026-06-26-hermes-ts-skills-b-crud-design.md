# 技能 b-1：skill_manage CRUD 设计

> 阶段：技能系统第二步（写入）。承接「技能 a（只读）」，新增 `skill_manage` 工具，让 agent 能创建/编辑/删除技能。
> 日期：2026-06-26
> 保真度：架构级对齐 Python 原版 `tools/skill_manager_tool.py` 的前台 CRUD 部分，惯用 TS 重写。

## 目标

一句话：给 agent 一个 `skill_manage` 工具，可在 `~/.hermes-ts/skills/` 下创建、整体重写、精确替换、删除技能，写入即时热更新到内存索引，delete 走审批确认。

## 范围

### 本次做
- `skill_manage` 工具，4 个动作：`create` / `edit` / `patch` / `delete`。
- `SkillStore` 变更 API（含校验、原子写、内存索引同步）。
- 写入后**即时热更新**：同会话 `skill_view` 立即可读，下一轮 system prompt 索引立即反映。
- `delete` 复用既有 `ApprovalGuard`（新增通用确认入口 `confirm()`）。

### 本次不做（留作后续阶段）
- 自改进 / 后台 review fork（技能 c）。
- curator 生命周期管家（active/stale/archived 自动归档/合并）。
- 支持文件 `write_file` / `remove_file`（`references/templates/scripts/assets`）——当前 `skill_view` 只读 `SKILL.md` 正文，无人消费，YAGNI。
- provenance（`.usage.json`、agent_created 标记）。
- 安全扫描（skills_guard）、staged 写审批。

## 架构

延续技能 a 的分层：**变更逻辑与文件系统操作落在 @hermes/core 的 `SkillStore`**（它本就是内存索引的所有者），**工具层 `skill_manage` 只做参数分发与校验提示**。`LoopDeps.skills` / `ToolContext.skills` / `ToolContext.approval` 注入管线在技能 a 与阶段 2.5 已就位，本次**无需改动 loop / repl / main**——`skill_manage` 自动拿到与 system prompt 同一个 `SkillStore` 实例，热更新天然生效。

### 文件改动
| 文件 | 改动 |
| --- | --- |
| `packages/core/src/skill-store.ts` | `SkillEntry` 增 `file` 字段；`SkillStore` 保存 `private readonly dir`（供变更方法构造路径与重解析）；新增 `create/edit/patch/delete` 方法 + 校验纯函数 + 原子写 |
| `packages/tools/src/approval.ts` | `ApprovalGuard` 新增 `confirm()` 通用确认（不走危险命令检测） |
| `packages/tools/src/builtin/skills.ts` | 新增 `skillManageTool` |
| `packages/tools/src/builtin/index.ts` | 注册 `skill_manage`（**两处**：`builtinTools` 数组 + `registerBuiltins`，与 `skill_view` 一致） |
| `README.md` / `docs/ROADMAP.md` | 标记技能 b-1 ✅，注明后续推迟项 |

## 组件设计

### ① SkillStore 变更 API（@hermes/core）

`SkillEntry` 增加 `file: string`（SKILL.md 绝对路径），供 edit/patch/delete 定位文件。`SkillStore` 保存 `private readonly dir`（构造时传入的技能根），变更方法用它构造路径并调用 `parseSkill(this.dir, file)` 重解析。

内存索引 `private readonly skills: SkillEntry[]` / `private readonly byName: Map` 的 `readonly` 仅限引用，**内容可变**；变更方法直接 `push`/`splice`/`set`/`delete`。`skills[]` 与 `byName` 持有**同一个** `SkillEntry` 对象——edit/patch 采用**就地修改该共享对象的 `content`/`description` 字段**（避免双处更新时 desync，也免去按下标查找）。

四个变更方法，统一流程：**校验 → 原子写（tmp + rename）→ 同步内存（仅在 `renameSync` 成功返回后才改内存）**。校验失败 `throw Error`（工具层捕获回灌模型自纠）。单进程 REPL 顺序调用工具，无需加锁。

- **`create(name, content, category?)`**
  - 校验 name / category / frontmatter / 正文 / 大小。
  - **强制一致**：frontmatter 的 `name` 必须等于参数 `name`（否则索引名与目录名错位）；不一致报错。
  - 唯一性：`byName` 已存在 → 报错「技能已存在」。
  - 目录：始终生成 `root/name/`（无 category 或 category 省略时）或 `root/<category>/name/`，`mkdir -p` 后原子写 `SKILL.md`。因 `parseSkill` 的 category 由路径反推，故 re-parse 出的 category 必等于入参（省略 category 时为 `general`，无目录段）。
  - 解析入 `skills`（push）/ `byName`（set）。返回写入路径。

- **`edit(name, fullContent)`**
  - 须存在（`byName`）。校验 fullContent 的 frontmatter / 正文 / 大小。
  - **不允许改 frontmatter 的 `name`**（改名 = delete + create）：校验阶段解析 fullContent 的 frontmatter，断言其 `name === 现 name`，否则报错——**在写盘前完成**，无需回滚。
  - 原子重写**同一路径**（category 由路径决定，保持不变）；写盘成功后就地更新共享条目的 `content` / `description`（description 取自已解析的 frontmatter）。

- **`patch(name, oldString, newString, replaceAll?)`**
  - 须存在。从盘读 raw SKILL.md（避免用陈旧内存）。
  - `replaceAll=false`（默认）：`oldString` 须**唯一**出现，否则报错（0 次「未找到」/ 多次「不唯一，请用 replace_all 或扩大上下文」）。
  - 替换用 `split(oldString).join(newString)`，避免 `$` 被正则替换语义损坏（沿用 `edit_file` 做法）。
  - 校验改后整体仍是合法 SKILL.md（frontmatter 必字段、正文非空、大小），**并与 edit 同样在写盘前断言改后 frontmatter 的 `name === 现 name`**（patch 也不可改 name，否则名/目录/索引错位）。
  - 原子写成功后就地更新共享条目的 `content` / `description`。

- **`delete(name)`**
  - 须存在。三重路径安全：解析后断言 dir 在 `skillsDir` 根内、**非根本身**、**非 symlink/junction**（`lstatSync().isSymbolicLink()`）。
  - `rmSync(dir, { recursive: true, force: true })`；移出 `skills` / `byName`。

### 校验（@hermes/core，纯函数，与 SkillStore 同文件）
- 名字：`^[a-z0-9][a-z0-9._-]*$`，长度 1–64。（`..` 因首字符须为字母数字而天然被拒。）
- category：可选；单段（不含 `/` `\`）；同名字规则；≤64。
- frontmatter：须以 `---` 起、有闭合 `---`、解析为 YAML 映射、含 `name`（string）与 `description`（string，≤1024）。
- 正文：闭合 `---` 后非空（trim 后）。
- SKILL.md 总长 ≤100000 字符。

### 安全
- 所有写入路径 `resolve` 后断言落在 `skillsDir()` 内（纵深防御，即便 name 校验已挡穿越）。
- 原子写：写 `*.tmp` 同目录后 `renameSync` 覆盖；失败清理 tmp，原文件不动。
- delete 三重防护：`resolve(dir)` 须以 `resolve(skillsDir()) + sep` 为前缀（根内）、`resolve(dir) !== resolve(skillsDir())`（非根本身）、`lstatSync(dir).isSymbolicLink()` 为假（非 symlink/junction；Node 在 Windows 上把目录 junction 也报为 symlink，故一并覆盖）。

### ② ApprovalGuard.confirm()（@hermes/tools）

`ApprovalGuard` 新增通用确认入口（复用同一 `prompt` 回调与 allowlist，但**不经 `detectDangerous`**——因 `skill_manage delete X` 不是 shell 命令，会被误判 safe）：

```ts
async confirm(req: ApprovalRequest): Promise<{ allowed: boolean; reason?: string }>
```
语义：
- `mode === 'off'` → 放行。
- `sessionAllow` / `persistentAllow` 命中 `req.command` → 放行。
- 无 `prompt` 通道 → **阻止**（不可逆操作默认拒，与 terminal 危险命令在无审批通道时一致）。
- 否则 `prompt(req)`：`deny` → 阻止；`session` → 记 session + 放行；`always` → 记 session + persistent（落盘）+ 放行；`once` → 放行。

allowlist key 用 `req.command`，调用方传 `skill:delete:<name>`，与 shell 命令字符串不冲突（同一 `allowlist.json`）。

### ③ skill_manage 工具（@hermes/tools）

```ts
schema: z.object({
  action: z.enum(['create', 'edit', 'patch', 'delete']),
  name: z.string().describe('技能名'),
  content: z.string().optional().describe('完整 SKILL.md（create/edit 必填）'),
  old_string: z.string().optional().describe('待替换文本（patch 必填）'),
  new_string: z.string().optional().describe('替换为（patch 必填）'),
  replace_all: z.boolean().optional().describe('替换全部出现（默认 false）'),
  category: z.string().optional().describe('分类目录段（create 可选）'),
})
```
handler：
- `!ctx.skills` → 返回 `技能系统不可用。`
- 按 `action` 分发，校验该动作必填参（缺 → `throw` 明确提示，如「create 需要 content」）。
- **`delete` 前**：`if (ctx.approval) { const r = await ctx.approval.confirm({ command: 'skill:delete:'+name, description: '删除技能 '+name }); if (!r.allowed) return r.reason ?? '已取消删除。'; }`
- 调 `ctx.skills.<action>(...)`，成功返回简短确认串（`已创建技能 "x"` / `已更新技能 "x"` / `已 patch 技能 "x"` / `已删除技能 "x"`）。
- 归入 `skills` 工具集（已并入 `core`，默认启用）。

## 数据流

```
模型发起 skill_manage(create, name, content)
  → ToolRegistry.call 捕获异常
  → handler 校验必填 → ctx.skills.create()
      → 校验(name/frontmatter/正文/大小) → 唯一性 → mkdir → 原子写 SKILL.md
      → 解析入 byName/skills(热更新)
  → 返回「已创建技能 x」
下一轮对话：buildSystemPrompt(deps.skills.renderIndex()) 已含新技能
本轮稍后：skill_view(x) 经 ctx.skills.getContent 立即可读
```

delete 多一步：handler → `ctx.approval.confirm` →（manual 模式弹 [o/s/a/d]）→ 允许才 `ctx.skills.delete`。

## 错误处理
- 校验/唯一性/未找到/patch 不唯一/路径越界 → `throw Error`，由 `ToolRegistry.call` 转成字符串回灌模型。
- delete 被拒 → 返回拒绝原因字符串（非异常）。
- 原子写失败 → 清理 tmp 后抛错；内存索引不变（先写盘成功再改内存）。

## 测试
- SkillStore：create（成功/重名/非法名/frontmatter.name 不一致/category 非法/正文空/超大/category 时目录与 re-parse 一致）；edit（成功/不存在/改 frontmatter name 被拒/就地更新后 skills 与 byName 同步）；patch（唯一替换/未找到/不唯一/replaceAll/`$` 安全/改后 frontmatter 失效被拒/**改 frontmatter name 被拒**）；delete（成功/不存在/根目录拒/symlink 拒）；热更新可见性（create/edit 后 list/getContent/renderIndex 立即一致，无 skills↔byName desync）。
- ApprovalGuard.confirm：off 放行 / 无 prompt 阻止 / deny 阻止 / session 记忆 / always 落盘。
- skill_manage 工具：分发、必填校验提示、delete 经 confirm（允许/拒绝两路）、`!ctx.skills` 路径。

## 验收标准（DoD）
- 新增测试约 25+，全部通过。
- 全包 `tsc --noEmit` 干净。
- README + ROADMAP 更新（技能 b-1 ✅；自改进/curator/支持文件标注推迟）。
- 不破坏既有 166 测试。
