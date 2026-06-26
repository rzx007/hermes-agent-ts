import {
  readFileSync, readdirSync, existsSync, writeFileSync,
  renameSync, mkdirSync, rmSync, lstatSync, type Dirent,
} from 'node:fs';
import { join, relative, dirname, basename, sep, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Logger } from './logging.js';

export interface SkillMeta {
  name: string;
  description: string;
  category: string;
}

interface SkillEntry extends SkillMeta {
  content: string;
  file: string;
}

export class SkillStore {
  private readonly skills: SkillEntry[] = [];
  private readonly byName = new Map<string, SkillEntry>();
  private readonly dir: string;
  private readonly logger?: Logger;

  constructor(dir: string, logger?: Logger) {
    this.dir = dir;
    this.logger = logger;
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
    return { name, description, category, content: body, file };
  }

  create(name: string, content: string, category?: string): { path: string } {
    validateSkillName(name);
    if (category !== undefined) validateCategory(category);
    const meta = validateAndParseContent(content);
    if (meta.name !== name) {
      throw new Error(`frontmatter 的 name "${meta.name}" 与参数 name "${name}" 不一致`);
    }
    if (this.byName.has(name)) throw new Error(`技能 "${name}" 已存在`);
    const skillDir = category !== undefined ? join(this.dir, category, name) : join(this.dir, name);
    const file = join(skillDir, 'SKILL.md');
    this.assertWithinRoot(file);
    const dirExisted = existsSync(skillDir);
    mkdirSync(skillDir, { recursive: true });
    try {
      atomicWrite(file, content);
      const entry = this.parseSkill(this.dir, file);
      this.skills.push(entry);
      this.byName.set(entry.name, entry);
      return { path: file };
    } catch (e) {
      // 写盘/解析中途失败:回滚刚建的目录,避免磁盘残留与内存不一致(仅清自己新建的,勿动共享 category 目录)
      if (!dirExisted) {
        try { rmSync(skillDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      throw e;
    }
  }

  edit(name: string, content: string): { path: string } {
    const existing = this.byName.get(name);
    if (!existing) throw new Error(`技能 "${name}" 不存在`);
    const meta = validateAndParseContent(content);
    if (meta.name !== name) {
      throw new Error(`不允许修改 frontmatter 的 name(现为 "${name}",新内容为 "${meta.name}");改名请删除后重建`);
    }
    atomicWrite(existing.file, content);
    // name 不可变 → 文件不移动 → category 不变,只需就地同步 content/description(skills[] 与 byName 共享同一对象)
    existing.content = meta.body;
    existing.description = meta.description;
    return { path: existing.file };
  }

  patch(name: string, oldString: string, newString: string, replaceAll = false): { path: string } {
    if (oldString.length === 0) throw new Error('patch 的 old_string 不能为空');
    const existing = this.byName.get(name);
    if (!existing) throw new Error(`技能 "${name}" 不存在`);
    const raw = readFileSync(existing.file, 'utf8');
    const occurrences = raw.split(oldString).length - 1;
    if (occurrences === 0) throw new Error('patch 未找到待替换文本(old_string)');
    if (!replaceAll && occurrences > 1) {
      throw new Error(`patch 待替换文本出现 ${occurrences} 次,不唯一;请用 replace_all 或扩大上下文`);
    }
    const next = raw.split(oldString).join(newString);
    const meta = validateAndParseContent(next);
    if (meta.name !== name) throw new Error('patch 不可修改 frontmatter 的 name;改名请删除后重建');
    atomicWrite(existing.file, next);
    existing.content = meta.body;
    existing.description = meta.description;
    return { path: existing.file };
  }

  private assertWithinRoot(p: string): void {
    const root = resolve(this.dir);
    const resolved = resolve(p);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new Error(`路径越界:${p} 不在技能根 ${this.dir} 内`);
    }
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

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_NAME = 64;
const MAX_DESC = 1024;
const MAX_CONTENT = 100000;

export function validateSkillName(name: string): void {
  if (name.length === 0 || name.length > MAX_NAME || !NAME_RE.test(name)) {
    throw new Error(`非法技能名 "${name}":须匹配 ^[a-z0-9][a-z0-9._-]*$ 且长度 1–${MAX_NAME}`);
  }
}

export function validateCategory(category: string): void {
  if (category.length === 0 || category.length > MAX_NAME || !NAME_RE.test(category)) {
    throw new Error(`非法分类 "${category}":须为单段且匹配 ^[a-z0-9][a-z0-9._-]*$`);
  }
}

/** 校验完整 SKILL.md 文本并取出 name/description/body；失败抛错 */
export function validateAndParseContent(content: string): { name: string; description: string; body: string } {
  if (content.length > MAX_CONTENT) {
    throw new Error(`SKILL.md 过大(${content.length} > ${MAX_CONTENT} 字符)`);
  }
  const { frontmatter, body } = splitFrontmatter(content);
  if (frontmatter === null) throw new Error('SKILL.md 必须以 YAML frontmatter(--- 包裹)开头');
  const parsed: unknown = parseYaml(frontmatter);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('frontmatter 必须是 YAML 映射');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.length === 0) throw new Error('frontmatter 缺少 name');
  if (typeof obj.description !== 'string' || obj.description.length === 0) {
    throw new Error('frontmatter 缺少 description');
  }
  if (obj.description.length > MAX_DESC) throw new Error(`description 过长(> ${MAX_DESC} 字符)`);
  if (body.trim().length === 0) throw new Error('SKILL.md 正文(frontmatter 之后)不能为空');
  return { name: obj.name, description: obj.description, body };
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}
