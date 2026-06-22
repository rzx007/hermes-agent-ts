import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type MemoryTarget = 'memory' | 'user';

const DELIM = '\n§\n';
const LIMITS: Record<MemoryTarget, number> = { memory: 2200, user: 1375 };
const FILES: Record<MemoryTarget, string> = { memory: 'MEMORY.md', user: 'USER.md' };
const TITLES: Record<MemoryTarget, string> = {
  memory: 'MEMORY(你的长期笔记)',
  user: 'USER(用户画像)',
};

export class MemoryStore {
  private readonly dir: string;
  private readonly entries: Record<MemoryTarget, string[]>;

  constructor(dir: string) {
    this.dir = dir;
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    this.entries = {
      memory: this.load('memory'),
      user: this.load('user'),
    };
  }

  getEntries(target: MemoryTarget): string[] {
    return [...this.entries[target]];
  }

  add(target: MemoryTarget, content: string): void {
    const c = content.trim();
    if (!c) throw new Error('记忆内容不能为空。');
    this.commit(target, [...this.entries[target], c]);
  }

  replace(target: MemoryTarget, oldText: string, content: string): void {
    const idx = this.uniqueIndex(target, oldText);
    const next = [...this.entries[target]];
    next[idx] = this.entries[target][idx]!.split(oldText).join(content);
    this.commit(target, next);
  }

  remove(target: MemoryTarget, oldText: string): void {
    const idx = this.uniqueIndex(target, oldText);
    this.commit(target, this.entries[target].filter((_, i) => i !== idx));
  }

  render(): string {
    const blocks: string[] = [];
    for (const target of ['memory', 'user'] as MemoryTarget[]) {
      const entries = this.entries[target];
      if (entries.length === 0) continue;
      const body = entries.join(DELIM);
      blocks.push(`════ ${TITLES[target]} [${body.length}/${LIMITS[target]}] ════\n${body}`);
    }
    return blocks.join('\n\n');
  }

  private uniqueIndex(target: MemoryTarget, oldText: string): number {
    const matches = this.entries[target]
      .map((e, i) => (e.includes(oldText) ? i : -1))
      .filter((i) => i !== -1);
    if (matches.length === 0) throw new Error(`未找到包含 "${oldText}" 的记忆条目。`);
    if (matches.length > 1) throw new Error(`"${oldText}" 命中多条记忆,请提供更长的上下文使其唯一。`);
    return matches[0]!;
  }

  private commit(target: MemoryTarget, next: string[]): void {
    const joined = next.join(DELIM);
    if (joined.length > LIMITS[target]) {
      throw new Error(
        `${FILES[target]} 超出 ${LIMITS[target]} 字上限(将达 ${joined.length})。请先用 remove 删除过时条目。当前条目:\n${this.entries[target].map((e, i) => `[${i}] ${e}`).join('\n')}`,
      );
    }
    this.writeAtomic(target, joined);
    this.entries[target] = next;
  }

  private load(target: MemoryTarget): string[] {
    try {
      const raw = readFileSync(join(this.dir, FILES[target]), 'utf8');
      if (raw.trim() === '') return [];
      return raw.split(DELIM);
    } catch {
      return [];
    }
  }

  private writeAtomic(target: MemoryTarget, content: string): void {
    const path = join(this.dir, FILES[target]);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  }
}
