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
