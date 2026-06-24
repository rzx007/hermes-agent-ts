# Hermes Agent TS — 技能 a:只读技能(Skills, read-only) 设计

- **日期**: 2026-06-21
- **状态**: 设计阶段
- **源项目**: `D:/code/personal-project/hermes-agent`(agent/prompt_builder.py 技能注入, tools/skills_tool.py, agent/skill_utils.py)
- **前置**: 阶段 1/2/2.5/3a/3b 已完成并合并。当前在 `phase-skills-a` 分支,基线 144 测试全绿。

---

## 1. 背景与目标

技能(skills)是 hermes 的"自进化"另一支柱:程序性知识(how-to / 最佳实践),以带 frontmatter 的 `SKILL.md` 存储。本阶段做**只读技能**:从磁盘加载技能、把技能索引(name+description)注入 system prompt 让模型知道有哪些技能、提供 `skill_view` 工具让模型按需读取技能正文。

完整技能系统很大(skill_manage 创建/编辑、后台自改进、斜杠命令激活、支撑文件树、bundle/plugin)。本阶段只做**读侧自包含核心**。写侧(skill_manage)与后台自改进各为后续独立阶段。结构与 3a 的 MemoryStore 同构。

---

## 2. 范围

### 2.1 做(MVP)
- **SkillStore**(@hermes/core,类比 MemoryStore):递归扫描 `~/.hermes-ts/skills/` 下每个 `*/SKILL.md`,用 `yaml` 解析 frontmatter(`name`、`description`),记录正文与 category;`list()` / `getContent(name)` / `renderIndex()`。
- **系统提示注入**:每轮把技能索引(按 category 列 name+description)注入 system prompt。
- **`skill_view` 工具**:按名返回技能正文。
- 新 `skills` toolset(并入 core)+ `ToolContext.skills` 注入 + `paths.skillsDir()`。

### 2.2 明确不做(推迟)
- **`skill_manage`**(模型创建/编辑/删除技能)→ 后续「技能 b」。
- **后台自改进**(fork agent 任务后自动补技能)→ 更后续。
- **`skills`(list)工具**:索引已注入 system prompt,模型已能看到全部 name+description,MVP 不单独做 list 工具(避免重复;技能很多时再改按需列出)。
- 斜杠命令 `/<skill>` 激活、支撑文件树(references/templates/scripts)、bundle/plugin、外部目录、平台/环境网关、磁盘快照缓存、安全扫描。

### 2.3 向后兼容
`ToolContext.skills` 与 `LoopDeps.skills` 均可选;不注入时 skill_view 返回"不可用",系统提示无技能块。现有 144 测试不受影响。

---

## 3. 文件结构

```
packages/core/src/
  skill-store.ts         (新) SkillStore
  skill-store.test.ts    (新)
  paths.ts               (改) skillsDir()
  paths.test.ts          (改) 补测
  index.ts               (改) 导出 skill-store
packages/tools/src/
  registry.ts            (改) ToolContext.skills?: SkillStore
  toolsets.ts            (改) skills toolset + core.includes 加 skills
  toolsets.test.ts       (改) 补测
  builtin/skills.ts       (新) skill_view 工具
  builtin/skills.test.ts  (新)
  builtin/index.ts        (改) 注册 skill_view
packages/agent/src/
  system-prompt.ts        (改) buildSystemPrompt(cwd, memoryBlock?, skillsBlock?)
  system-prompt.test.ts   (改) 补测
  conversation-loop.ts    (改) LoopDeps.skills? + 注入 renderIndex()
  conversation-loop.test.ts (改) 补测
apps/cli/src/
  main.ts                 (改) 创建 SkillStore 放进 deps
  repl.ts                 (改) 每轮注入 ctx.skills
```
依赖方向不变。SkillStore 放 @hermes/core(类比 SessionDB/MemoryStore,tools 与 agent 都用)。

---

## 4. SkillStore(`packages/core/src/skill-store.ts`)

```ts
export interface SkillMeta { name: string; description: string; category: string }

export class SkillStore {
  constructor(dir: string);                  // 构造时递归扫描;目录不存在时容错(空)
  list(): SkillMeta[];
  getContent(name: string): string | null;   // 技能 SKILL.md 正文(去 frontmatter);未知→null
  renderIndex(): string;                     // 按 category 列;无技能→''
}
```

### 4.1 磁盘格式与扫描
- 技能 = 含 `SKILL.md` 的目录。递归遍历 `dir` 查找所有 `SKILL.md`(忽略 `node_modules`/`.git`)。**扫描结果按 SKILL.md 相对路径排序**,保证"同名首个生效"在跨平台(Windows readdir 顺序与 POSIX 不同)上确定、可测。
- `SKILL.md` 格式:`---\n<yaml frontmatter>\n---\n<markdown 正文>`。**frontmatter 解析精确规则**:仅当文件**首行**为 `---` 时才视为有 frontmatter;以**第一个**后续的 `---` 行作为闭合(正文里的 `---` 水平分隔线不算);两者之间用 `yaml`(core 已依赖)解析。无首行 `---` → 整个文件为正文、无 frontmatter。
- frontmatter 解析结果**若非对象**(yaml 解析出标量/数组/null)→ 当作无有效 frontmatter,走下面的字段回退(而非抛错)。
- **name**:frontmatter 对象的 `name`(字符串);缺失/非字符串 → 回退为技能目录的 basename。
- **description**:frontmatter 对象的 `description`(字符串);缺失/非字符串 → `''`。
- **category**:技能目录(SKILL.md 的父目录)相对 `dir` 的**父路径**(POSIX 化);技能目录直接位于 `dir` 下 → `'general'`。
- **content**:`SKILL.md` 去掉 frontmatter 后的正文(若无 frontmatter 分隔,则整文件为正文)。
- 同名技能(name 冲突):首个生效,后续 `logger?.warn` 跳过(getContent 需唯一)。
- 单个技能解析失败(读错/frontmatter 非法)→ 跳过该技能 + `logger?.warn`,不影响其它。
- 构造可选接受 `logger`:`constructor(dir: string, logger?: Logger)`。

### 4.2 list / getContent / renderIndex
- `list()`:返回各技能 `{name, description, category}`(去重后)。
- `getContent(name)`:按 name 找到技能,返回其正文;找不到返回 `null`。
- `renderIndex()`:按 category 分组,每技能一行 `- **<name>** — <description>`;块标题如「可用技能(用 skill_view 读取正文):」;无技能返回 `''`。

---

## 5. 系统提示注入 + skill_view 工具

### 5.1 system-prompt.ts
签名扩为 `buildSystemPrompt(cwd: string, memoryBlock?: string, skillsBlock?: string): string`。在身份/时间/cwd/记忆之后,若 `skillsBlock` 非空则附加(清晰标题)。`conversation-loop.ts`:`LoopDeps` 加 `skills?: SkillStore`;构建 system 消息时 `buildSystemPrompt(ctx.cwd, deps.memory?.render(), deps.skills?.renderIndex())`。
> 注:buildSystemPrompt 现有签名 `(cwd, memoryBlock?)` → 加第三参 `skillsBlock?`,向后兼容。
> 同时:system-prompt.ts 顶部有 `// TODO(阶段4): 注入技能 / 人格` 注释,本阶段实现技能注入后应更新该注释(去掉"技能",保留"人格"待后续)。

### 5.2 skill_view 工具(`packages/tools/src/builtin/skills.ts`)
```ts
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
- 新 `skills` toolset:`{ description:'技能(程序性知识)', tools:['skill_view'] }`;`core.includes` 追加 `'skills'`。
- `registry.ts`:`ToolContext.skills?: SkillStore`(`import type { SkillStore } from '@hermes/core'`)。
- `builtin/index.ts`:import + builtinTools + registerBuiltins。

---

## 6. CLI 接线 + paths

- `paths.skillsDir(env?)` = `join(getHermesHome(env), 'skills')`。
- `main.ts`:`const skills = new SkillStore(skillsDir(), logger)` → 放进 `deps.skills`(logger 已存在)。
- `repl.ts`:每轮注入 `skills: deps.skills`。
- 同一 SkillStore 实例:系统提示读 + 工具读。MVP 启动时一次性扫描(创建技能是后续 skill_manage,故本会话内无需重扫)。

---

## 7. 错误处理

| 情况 | 处理 |
|------|------|
| 无 ctx.skills | skill_view 返回「技能系统不可用」 |
| skill_view 未知技能名 | throw(附可用技能名)→ registry 回灌 |
| skillsDir 不存在/空 | 空索引(不注入技能块);list 为空 |
| 单个 SKILL.md 解析失败 | 跳过 + logger.warn |
| 同名技能 | 首个生效 + warn |

原则:工具层错误回灌模型;加载层失败降级为跳过/空。

---

## 8. 测试(Vitest)

| 测试 | 覆盖 |
|------|------|
| `skill-store.test.ts` | 扫描临时目录加载 SKILL.md;frontmatter name/description 解析;category 推导(子目录 vs general);getContent 返回正文(去 frontmatter);未知名→null;renderIndex 含 name+description、空目录→'';frontmatter 缺 name→回退目录名;无 frontmatter 文件→整文件为正文;解析失败跳过不崩;同名首个生效 |
| `skills.test.ts`(工具) | skill_view 返回正文;未知名报错(含可用名);无 ctx.skills→不可用 |
| `paths.test.ts`(补) | skillsDir → ~/.hermes-ts/skills |
| `toolsets.test.ts`(补) | skills toolset 存在;core 含 skill_view |
| `system-prompt.test.ts`(补) | 带 skillsBlock 含之;不带不含;cwd/memory 仍在 |
| `conversation-loop.test.ts`(补) | 注入 deps.skills 后 system 消息含技能索引(mock SkillStore.renderIndex) |

文件测试用 mkdtempSync 临时目录。

### 8.1 完成定义(DoD)
- 新测试全绿 + 原 144 无回归 + 全包 `tsc --noEmit` 干净。
- 手动:放 `~/.hermes-ts/skills/demo/SKILL.md`(含 frontmatter),`pnpm cli` 让模型「列出你的技能并用 demo」→ 系统提示含技能索引,模型调 `⚙ skill_view(demo)` 读到正文。
- README + ROADMAP 更新(技能 a ✅;skill_manage/自改进待后续)。

---

## 9. 后续衔接点
- **技能 b**:`skill_manage`(create/edit/patch/delete + 支撑文件 write)——自进化写侧。
- 后台自改进(fork 辅助 agent,白名单 memory+skill_manage 工具,任务后自动补技能)。
- 斜杠命令 `/<skill>` 激活、支撑文件 skill_view(file_path)、bundle/plugin、外部目录、平台/环境网关、技能很多时改按需 list 工具 + 索引精简。
