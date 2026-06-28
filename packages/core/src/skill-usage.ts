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

  // 注:get/entries 返回 map 内的活引用,勿直接改字段;变更一律走 create/record(才会落盘)。
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
