import { readFileSync, readdirSync, existsSync, type Dirent } from 'node:fs';
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
    const files = this.findSkillFiles(dir).sort();
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

  private findSkillFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
      let entries: Dirent[];
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
    const relParent = relative(root, dirname(skillDir));
    const category =
      relParent === '' || relParent === '..' ? 'general' : relParent.split(sep).join('/');
    return { name, description, category, content: body };
  }
}

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
  return { frontmatter: null, body: raw };
}
