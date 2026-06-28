# 技能 c-2：provenance + curator 归档 设计

> 阶段：技能系统第四步（自清理）。承接技能 a/b-1/c-1，新增「技能 provenance + 生命周期 + 自动归档」——技能库能记住每条技能的来源与使用情况，并自动把久未使用的 agent 自建技能归档。
> 日期：2026-06-28
> 保真度：架构级对齐 Python 原版 `tools/skill_usage.py` + `tools/skill_provenance.py` + `agent/curator.py` 的归档部分，惯用 TS 重写。

## 目标

一句话：给技能库加一层使用画像（`.usage.json`：谁建的、用了多少次、最近何时用），并据此在 CLI 启动时（及 `/curate` 手动）自动把「agent 自建且久未使用」的技能移到 `.archive/`——用户手建的技能永不自动归档。

## 范围

### 本次做
- **provenance**：`.usage.json` sidecar 记录每条技能的 `agentCreated` / 时间戳 / view·patch 计数 / 生命周期 state。
- **使用记录接线**：`skill_view` 记一次 view；`skill_manage` create/edit/patch/delete 记 provenance；自改进 review 的写入标记为 agent 自建。
- **curator 归档**：`runCurator` 策略——把 agentCreated 且闲置超阈值的技能归档（移到 `.archive/` + 移出索引）。
- **CLI 接线**：启动时跑一次 curator（打印摘要）+ `/curate` 命令手动触发 + `skillArchiveDays` 配置。

### 本次不做（留后续阶段）
- curator **合并/consolidation**（用 LLM 把相似/冗余技能合到 umbrella）。
- 技能**支持文件**（`write_file`/`remove_file`）。
- **记忆自改进**（review 扩展到 memory）。
- **stale 预警态**作为独立动作（本次 stale 只作信息计算，不单独处理；只有 archived 是实际动作）。
- 归档**恢复命令**（归档目录保留在 `.archive/` 可手工恢复，但不提供 restore 命令）。

## 架构

延续分层：**provenance 存储与生命周期策略落在 `@hermes/core`**（SkillStore 是技能状态的所有者），**工具层只做记录调用**，**CLI 接线触发 curator**。三个新关注点拆成独立单元：`SkillUsage`（持久化）/ `SkillStore.archive`（移动 + 索引）/ `runCurator`（策略）——各自可独立测试。

### 文件改动
| 文件 | 改动 |
| --- | --- |
| `packages/core/src/skill-usage.ts` | 新建：`SkillUsage` 类（`.usage.json` 读写 + record/remove/get/entries） |
| `packages/core/src/skill-curator.ts` | 新建：`runCurator(skills, opts)` + `CuratorReport` |
| `packages/core/src/skill-store.ts` | 集成 `SkillUsage`；create 加 `opts.agentCreated`；edit/patch/delete 记录；新增 `recordView`/`archive`；扫描跳过 `.archive` |
| `packages/core/src/config.ts` | `skillArchiveDays`（`HERMES_SKILL_ARCHIVE_DAYS`，默认 30，0=关闭；不走 `\|\|`） |
| `packages/core/src/index.ts` | 导出 `SkillUsage` / `runCurator` / `CuratorReport` 等 |
| `packages/tools/src/registry.ts` | `ToolContext` 加 `backgroundReview?: boolean` |
| `packages/tools/src/builtin/skills.ts` | `skill_view` 调 `recordView`；`skill_manage` create 传 `agentCreated: ctx.backgroundReview ?? false` |
| `packages/agent/src/skill-review.ts` | runner 调 `registry.call` 时传 `{ ...ctx, backgroundReview: true }` |
| `apps/cli/src/main.ts` | 启动时跑 curator + 打印摘要；传 `skillArchiveDays` |
| `apps/cli/src/repl.ts` | `/curate` 命令 |
| `README.md` / `docs/ROADMAP.md` | 技能 c-2 ✅ + 推迟项 |

## 组件设计

### ① SkillUsage（`@hermes/core/skill-usage.ts`）

`.usage.json`（路径 = `join(skillsDir, '.usage.json')`），形如：
```json
{
  "batch-edit": { "agentCreated": true, "createdAt": "2026-06-28T...", "lastUsedAt": "2026-06-28T...", "viewCount": 3, "patchCount": 1, "state": "active" }
}
```

```ts
export type SkillState = 'active' | 'archived';
export interface SkillUsageEntry {
  agentCreated: boolean;
  createdAt: string;   // ISO
  lastUsedAt: string;  // ISO
  viewCount: number;
  patchCount: number;
  state: SkillState;
}
export class SkillUsage {
  constructor(path: string, logger?: Logger);          // 加载容错:坏 json → 空 map + warn
  get(name: string): SkillUsageEntry | undefined;
  entries(): Array<[string, SkillUsageEntry]>;
  create(name: string, opts: { agentCreated: boolean; now?: Date }): void;   // 身份事件:整条覆盖
  record(name: string, opts: { view?: boolean; patch?: boolean; state?: SkillState; now?: Date }): void; // 变更事件:就地改
  remove(name: string): void;
}
```
**两类写入分离**（这是修正「归档后同名重建」provenance 损坏的关键）：

- `create(name, {agentCreated, now})` —— **技能身份的定义事件，整条覆盖/新建**：`createdAt = lastUsedAt = now`，`viewCount = patchCount = 0`，`state = 'active'`，`agentCreated = 入参`。**会覆盖任何已存在的旧条目**（含被归档后 state='archived'/agentCreated=true 的残留），所以前台重建一个曾被 curator 归档的同名技能时，provenance 被正确重置为「用户建、active」。
- `record(name, {view?, patch?, state?, now})` —— **变更事件，就地改已有条目**；若条目不存在则先以 `agentCreated=false` 新建一条 active（覆盖「磁盘上已有但无 usage 条目」的旧技能首次被 view/patch 的情况）。`view` → `viewCount++`+`lastUsedAt=now`；`patch` → `patchCount++`+`lastUsedAt=now`；`state` → 设置 state。**record 永不改 `agentCreated`**（避免 edit/patch 误标用户建技能）。
- 每次变更后原子写盘（tmp+rename，失败 warn 不抛）。`now` 默认 `new Date()`，可注入便于测试。

**关键不变量**：`.usage.json` 里**没有条目的技能 = 用户建（agentCreated 视为 false）**，curator 永不动它——保证向后兼容已有技能与保守安全。

### ② SkillStore 集成（改 `skill-store.ts`）

- 构造时 `this.usage = new SkillUsage(join(dir, '.usage.json'), logger)`。
- `create(name, content, category?, opts?: { agentCreated?: boolean })`：写盘+入索引后 `this.usage.create(name, { agentCreated: opts?.agentCreated ?? false })`（用 `create` 整条覆盖，保证同名重建重置 provenance）。注:新增的可选第 4 参对现有 3 参调用方（skill_manage）向后兼容。
- `edit` / `patch`：成功后 `this.usage.record(name, { patch: true })`。
- `delete`：移出索引后 `this.usage.remove(name)`。
- 新增 `recordView(name)`：`if (this.byName.has(name)) this.usage.record(name, { view: true })`（只为已知技能记）。
- 新增 `usageEntries(): Array<[string, SkillUsageEntry]>` 转发 `this.usage.entries()`，供 curator 读取（**只暴露这一个读取入口**，不另出 `getUsage()`）。
- 新增 `archive(name): void`：
  - `byName.get(name)`；不存在 throw。
  - 三重路径安全（同 delete：根内 `startsWith(root+sep)` / 非根 / 非 symlink `lstatSync`）。
  - 目标 = `join(dir, '.archive', name)`；若已存在先 `rmSync` 旧的（再次归档同名）；`renameSync(skillDir, target)`。
  - `this.usage.record(name, { state: 'archived' })`。
  - 移出 `skills[]` + `byName`（不再被提供/注入索引）。
- `findSkillFiles` 的跳过集合加入 `.archive`（与 `node_modules`/`.git` 并列），使归档技能不被重扫加载。`.usage.json` 本就不会被当技能(扫描只收 `SKILL.md`)。

### ③ runCurator（`@hermes/core/skill-curator.ts`）

```ts
export interface CuratorReport { scanned: number; archived: string[] }
export interface CuratorOpts { archiveAfterDays: number; now?: Date }
export function runCurator(skills: SkillStore, opts: CuratorOpts): CuratorReport;
```
逻辑：
- `archiveAfterDays <= 0` → 直接返回 `{scanned:0, archived:[]}`（关闭）。
- 遍历 `skills.usageEntries()`：仅 `agentCreated === true && state === 'active'`。
- 闲置天数 = `(now - new Date(lastUsedAt ?? createdAt)) / 天`；> `archiveAfterDays` → `skills.archive(name)`，记入 `archived`。（正常条目 `lastUsedAt` 必有值;`?? createdAt` 仅为防御坏数据。若时间戳缺/坏 → `Invalid Date` → 天数 `NaN` → `NaN > x` 为 false → **不归档**,保守安全。）
- 单条归档异常 → warn 跳过（best-effort，不中断整体）。
- 返回报告供打印。

### ④ provenance 接线
- `ToolContext` 加 `backgroundReview?: boolean`。
- `skill_view`（`builtin/skills.ts`）：取到 content 后、return 前 `ctx.skills.recordView(name)`。
- `skill_manage` create 分支：`ctx.skills.create(name, args.content, args.category, { agentCreated: ctx.backgroundReview ?? false })`。
- `runSkillReview`（`skill-review.ts`）：**唯一注入点 = runner 内 `registry.call` 那一行**（现为 `registry.call(call.name, call.arguments, ctx)`，改成 `{ ...ctx, backgroundReview: true }`）——自改进写入在此权威地标记为 agent 自建，不依赖调用方设置。**注意：repl 里构造 `reviewCtx` 字面量时不要设 `backgroundReview`**（单一真相源在 runner，避免两处都设导致漂移）。

### ⑤ CLI 接线
- `config.skillArchiveDays`：默认 **30**，`0`=关闭，不用 `||`。注:现有 `parseInterval`(config.ts) 的 NaN 回退硬编码为 10——**不能直接复用**。把它**泛化为带默认参的 `parseIntConfig(v, fileVal, fallback)`**(NaN/缺省 → fallback)，并把 `skillNudgeInterval` 改用 `parseIntConfig(env.HERMES_SKILL_NUDGE_INTERVAL, fromFile.skillNudgeInterval, 10)`、`skillArchiveDays` 用 `..., 30)`。`0` 在两者都原样保留(不被当 falsy)。
- `main.ts`：构造 skills 后、进 repl 前：
  ```ts
  const report = runCurator(skills, { archiveAfterDays: config.skillArchiveDays, now: new Date() });
  if (report.archived.length) logger.info(...) / console.log(`🗃 已归档 ${report.archived.length} 个久未用技能:${report.archived.join(', ')}`);
  ```
- `repl.ts`：`/curate` 命令——跑 `runCurator(deps.skills, {archiveAfterDays, now:new Date()})` 并打印报告:`skillArchiveDays===0` → 「归档已关闭(HERMES_SKILL_ARCHIVE_DAYS=0)」;否则归档非空打印列表、空则「无可归档技能」。需要 repl 拿到 `skillArchiveDays`（加入 `ReplOptions`，由 main 传入）。repl 已有 `deps.skills`。

## 数据流

```
启动:main 建 SkillStore(载入 .usage.json)→ runCurator(now)
  → 对每个 agentCreated+active+闲置>阈值 → skills.archive(移盘到 .archive + usage.state=archived + 移出索引)
  → 打印 🗃 摘要 → 进 repl(系统提示索引已不含归档技能)
会话中:
  skill_view(x) → ctx.skills.recordView(x) → usage lastUsedAt/viewCount 更新
  skill_manage create(前台) → agentCreated=false(用户建,永不自动归档)
  后台 review skill_manage create → backgroundReview=true → agentCreated=true(可被 curator 管)
  /curate → 手动再跑 runCurator
```

## 错误处理
- `.usage.json` 坏/缺 → 空 map + warn，不崩；缺条目按用户建处理（安全）。
- usage 写盘失败 → warn，不抛（provenance 是辅助信息，不应阻断主操作）。
- curator 单条 archive 失败 → warn 跳过；整体 best-effort，绝不阻断启动或 repl。
- archive 路径安全失败 → throw（在 SkillStore.archive 内，curator 捕获为单条跳过）。
- usage 条目时间戳缺/坏 → 闲置天数 NaN → 不归档(保守，见 §③)。

## 测试
- `SkillUsage`：record 新建/view++/patch++/state 设置；agentCreated 首建定、后续不被覆盖;remove;缺条目 get→undefined；坏 json 容错;原子写后可重新加载。
- `SkillStore`：create 记 provenance（agentCreated 透传）；recordView 更新 lastUsedAt/viewCount(且只对已知技能)；archive 移盘到 .archive + 移出索引 + usage.state=archived；重扫跳过 .archive(归档技能不再加载)；delete 同时 usage.remove。
- `runCurator`：只归档 agentCreated+active+超阈值；用户建(无条目或 agentCreated=false)不动;active 未超阈值不动;`archiveAfterDays=0` 关闭;`now` 注入确定性(造一条 lastUsedAt 很久以前的 agent 技能 → 被归档)；坏时间戳条目 → NaN → 不归档。
- **同名重建重置 provenance**(对应 C2):create 一个 agent 技能 → archive 它(usage state=archived,agentCreated=true)→ 前台 create 同名 → usage 条目被 `create` 覆盖为 agentCreated=false、state=active(断言不再被 curator 视为可归档)。
- provenance 接线:`skill_manage` create 在 `ctx.backgroundReview=true` 下标 agentCreated；前台(无标记/3 参旧调用)为 false。`skill_view` 调 recordView。
- **全 review 路径 provenance**(集成):用 stub provider 驱动 `runSkillReview` 发一个 skill_manage create 调用 → 断言结果 usage 条目 `agentCreated===true`(守住 runner 注入 backgroundReview 这条跨包链)。
- config:`skillArchiveDays` 默认 30 / env / 0 关闭 / 非法回退（用 HOME() hermetic）。

## 验收标准（DoD）
- 新增测试约 18+，全部通过。
- 全包 `tsc --noEmit` 干净。
- README + ROADMAP 更新（技能 c-2 ✅；合并/支持文件/记忆自改进/恢复命令 标推迟）。
- 不破坏既有 212 测试。
