import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillStore } from './skill-store.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hermes-skill-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeSkill(rel: string, frontmatter: string, body: string): void {
  const full = join(dir, rel);
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`, 'utf8');
}

const SKILL = (name: string, desc = 'd', body = '正文内容') =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}`;

test('扫描加载 + frontmatter name/description', () => {
  writeSkill('demo', 'name: demo\ndescription: 演示技能', '# Demo\n步骤一二三');
  const s = new SkillStore(dir);
  const list = s.list();
  expect(list).toHaveLength(1);
  expect(list[0]!.name).toBe('demo');
  expect(list[0]!.description).toBe('演示技能');
});

test('getContent 返回正文(去 frontmatter)', () => {
  writeSkill('demo', 'name: demo\ndescription: d', '# Demo\n正文内容');
  const s = new SkillStore(dir);
  const content = s.getContent('demo')!;
  expect(content).toContain('# Demo');
  expect(content).toContain('正文内容');
  expect(content).not.toContain('description: d');
});

test('getContent 未知名返回 null', () => {
  const s = new SkillStore(dir);
  expect(s.getContent('nope')).toBeNull();
});

test('category:子目录 vs general', () => {
  writeSkill('coding/refactor', 'name: refactor\ndescription: r', 'body');
  writeSkill('toplevel', 'name: toplevel\ndescription: t', 'body');
  const s = new SkillStore(dir);
  const byName = Object.fromEntries(s.list().map((m) => [m.name, m.category]));
  expect(byName['refactor']).toBe('coding');
  expect(byName['toplevel']).toBe('general');
});

test('正文含 --- 水平线:只取第一个闭合 frontmatter', () => {
  writeSkill('hr', 'name: hr\ndescription: d', '正文上\n---\n正文下(水平线)');
  const s = new SkillStore(dir);
  const c = s.getContent('hr')!;
  expect(c).toContain('正文上');
  expect(c).toContain('正文下(水平线)');
  expect(c).not.toContain('description: d');
});

test('无 frontmatter:整文件为正文,name 回退目录名', () => {
  const full = join(dir, 'raw');
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, 'SKILL.md'), '# 无 frontmatter 的技能\n直接正文', 'utf8');
  const s = new SkillStore(dir);
  expect(s.list()[0]!.name).toBe('raw');
  expect(s.list()[0]!.description).toBe('');
  expect(s.getContent('raw')!).toContain('直接正文');
});

test('frontmatter 缺 name 回退目录名', () => {
  writeSkill('mydir', 'description: 只有描述', 'body');
  const s = new SkillStore(dir);
  expect(s.list()[0]!.name).toBe('mydir');
  expect(s.list()[0]!.description).toBe('只有描述');
});

test('frontmatter 是非对象(标量)→ 回退', () => {
  writeSkill('scalar', 'just a string', 'body');
  const s = new SkillStore(dir);
  expect(s.list()[0]!.name).toBe('scalar');
  expect(s.list()[0]!.description).toBe('');
});

test('renderIndex 含 name+description;空目录 → ""', () => {
  expect(new SkillStore(dir).renderIndex()).toBe('');
  writeSkill('demo', 'name: demo\ndescription: 演示', 'body');
  const idx = new SkillStore(dir).renderIndex();
  expect(idx).toContain('demo');
  expect(idx).toContain('演示');
});

test('解析失败的技能跳过不崩(坏 yaml)', () => {
  writeSkill('good', 'name: good\ndescription: g', 'body');
  const bad = join(dir, 'bad');
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, 'SKILL.md'), '---\nname: [unclosed\n---\nbody', 'utf8');
  const s = new SkillStore(dir);
  expect(s.list().some((m) => m.name === 'good')).toBe(true);
});

test('同名技能首个生效(按路径排序确定)', () => {
  writeSkill('a-first', 'name: dup\ndescription: 第一个', 'body A');
  writeSkill('z-second', 'name: dup\ndescription: 第二个', 'body Z');
  const s = new SkillStore(dir);
  expect(s.getContent('dup')).toContain('body A');
  expect(s.list().filter((m) => m.name === 'dup')).toHaveLength(1);
});

test('目录不存在不崩', () => {
  expect(() => new SkillStore(join(dir, 'nonexistent'))).not.toThrow();
  expect(new SkillStore(join(dir, 'nonexistent')).list()).toEqual([]);
});

test('SKILL.md 直接位于 skills 根目录 → category general(不是 ..)', () => {
  // 不经 writeSkill(它会建子目录),直接在 dir 根写 SKILL.md
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: rootskill\ndescription: 根技能\n---\n正文', 'utf8');
  const s = new SkillStore(dir);
  const meta = s.list().find((m) => m.name === 'rootskill')!;
  expect(meta.category).toBe('general');
});

test('create 新建技能并即时热更新（list/getContent/renderIndex 立即可见）', () => {
  const store = new SkillStore(dir);
  const { path } = store.create('git-commit', SKILL('git-commit', '规范提交'));
  expect(existsSync(path)).toBe(true);
  expect(readFileSync(path, 'utf8')).toContain('name: git-commit');
  expect(store.getContent('git-commit')).toContain('正文内容');
  expect(store.list().map((s) => s.name)).toContain('git-commit');
  expect(store.renderIndex()).toContain('git-commit');
});

test('create 带 category 落在子目录，category 与入参一致', () => {
  const store = new SkillStore(dir);
  store.create('code-review', SKILL('code-review'), 'coding');
  expect(existsSync(join(dir, 'coding', 'code-review', 'SKILL.md'))).toBe(true);
  expect(store.list().find((s) => s.name === 'code-review')?.category).toBe('coding');
});

test('create 重名报错', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'));
  expect(() => store.create('a', SKILL('a'))).toThrow(/已存在/);
});

test('create 非法名报错', () => {
  const store = new SkillStore(dir);
  expect(() => store.create('Bad Name', SKILL('Bad Name'))).toThrow(/非法技能名/);
  expect(() => store.create('..', SKILL('..'))).toThrow(/非法技能名/);
});

test('create frontmatter.name 与参数 name 不一致报错', () => {
  const store = new SkillStore(dir);
  expect(() => store.create('foo', SKILL('bar'))).toThrow(/不一致/);
});

test('create 非法 category 报错', () => {
  const store = new SkillStore(dir);
  expect(() => store.create('x', SKILL('x'), 'bad/seg')).toThrow(/非法分类/);
});

test('create 正文为空报错', () => {
  const store = new SkillStore(dir);
  expect(() => store.create('x', `---\nname: x\ndescription: d\n---\n\n   `)).toThrow(/正文/);
});

test('create 缺 frontmatter 报错', () => {
  const store = new SkillStore(dir);
  expect(() => store.create('x', '没有 frontmatter')).toThrow(/frontmatter/);
});

test('edit 整体重写并就地更新（skills 与 byName 同步、无 desync）', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a', '旧描述', '旧正文'));
  store.edit('a', SKILL('a', '新描述', '新正文'));
  expect(store.getContent('a')).toContain('新正文');
  expect(store.getContent('a')).not.toContain('旧正文');
  expect(store.list().find((s) => s.name === 'a')?.description).toBe('新描述');
});

test('edit 不存在的技能报错', () => {
  const store = new SkillStore(dir);
  expect(() => store.edit('nope', SKILL('nope'))).toThrow(/不存在/);
});

test('edit 改 frontmatter name 被拒', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'));
  expect(() => store.edit('a', SKILL('b'))).toThrow(/name/);
});

test('patch 精确替换（唯一）', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a', 'd', '步骤一：foo'));
  store.patch('a', '步骤一：foo', '步骤一：bar');
  expect(store.getContent('a')).toContain('步骤一：bar');
});

test('patch 未找到报错', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'));
  expect(() => store.patch('a', '不存在的文本', 'x')).toThrow(/未找到/);
});

test('patch 不唯一报错（除非 replace_all）', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a', 'd', 'dup dup dup'));
  expect(() => store.patch('a', 'dup', 'x')).toThrow(/不唯一/);
  store.patch('a', 'dup', 'x', true);
  expect(store.getContent('a')).toContain('x x x');
});

test('patch 含 $ 的替换不被损坏', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a', 'd', 'PRICE_HERE'));
  store.patch('a', 'PRICE_HERE', '$1.00 与 $name');
  expect(store.getContent('a')).toContain('$1.00 与 $name');
});

test('patch 改坏 frontmatter 被拒', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'));
  expect(() => store.patch('a', 'description: d\n', '')).toThrow(/description/);
});

test('patch 改 frontmatter name 被拒', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'));
  expect(() => store.patch('a', 'name: a', 'name: b')).toThrow(/name/);
});

test('patch 空 old_string 报错', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'));
  expect(() => store.patch('a', '', 'x')).toThrow();
});

test('delete 删除技能并移出索引', () => {
  const store = new SkillStore(dir);
  store.create('a', SKILL('a'));
  expect(existsSync(join(dir, 'a', 'SKILL.md'))).toBe(true);
  store.delete('a');
  expect(existsSync(join(dir, 'a'))).toBe(false);
  expect(store.getContent('a')).toBeNull();
  expect(store.list().map((s) => s.name)).not.toContain('a');
});

test('delete 不存在的技能报错', () => {
  const store = new SkillStore(dir);
  expect(() => store.delete('nope')).toThrow(/不存在/);
});

test('delete 软链接技能目录被拒（不删 symlink/junction）', async () => {
  // 扫盘会跳过 symlink 目录(isDirectory()=false)，所以不能靠扫描发现 symlink 技能。
  // 正确做法：先正常 create 真实技能（store 内存已有条目），再把它的磁盘目录替换成 junction。
  const { symlinkSync } = await import('node:fs');
  const store = new SkillStore(dir);
  store.create('a', SKILL('a')); // byName 有 'a'，file=dir/a/SKILL.md
  const target = mkdtempSync(join(tmpdir(), 'hermes-skill-tgt-'));
  rmSync(join(dir, 'a'), { recursive: true, force: true });
  let linked = true;
  try {
    symlinkSync(target, join(dir, 'a'), 'junction'); // Windows junction 无需管理员
  } catch {
    linked = false; // 平台不支持则跳过断言（仍通过）
  }
  if (linked) {
    expect(() => store.delete('a')).toThrow(/symlink|链接/i);
  }
  rmSync(target, { recursive: true, force: true });
});
