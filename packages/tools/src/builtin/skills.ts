import { z } from 'zod';
import { defineTool } from '../registry.js';

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

export const skillManageTool = defineTool({
  name: 'skill_manage',
  description:
    '管理技能(程序性知识):create=新建,edit=整体重写 SKILL.md,patch=精确替换正文片段,delete=删除。' +
    '技能为 SKILL.md(YAML frontmatter 必含 name/description,之后是正文)。create/edit 传 content;patch 传 old_string/new_string。',
  toolset: 'skills',
  schema: z.object({
    action: z.enum(['create', 'edit', 'patch', 'delete']),
    name: z.string().describe('技能名(lowercase,匹配 ^[a-z0-9][a-z0-9._-]*$,≤64)'),
    content: z.string().optional().describe('完整 SKILL.md(create/edit 必填)'),
    old_string: z.string().optional().describe('待替换文本(patch 必填,默认须唯一)'),
    new_string: z.string().optional().describe('替换为的文本(patch 必填)'),
    replace_all: z.boolean().optional().describe('替换全部出现(patch,默认 false)'),
    category: z.string().optional().describe('分类目录段(create 可选,单段)'),
  }),
  handler: async (args, ctx) => {
    if (!ctx.skills) return '技能系统不可用。';
    const { action, name } = args;
    switch (action) {
      case 'create': {
        if (args.content === undefined) throw new Error('create 需要 content(完整 SKILL.md)');
        ctx.skills.create(name, args.content, args.category);
        return `已创建技能 "${name}"。`;
      }
      case 'edit': {
        if (args.content === undefined) throw new Error('edit 需要 content(完整 SKILL.md)');
        ctx.skills.edit(name, args.content);
        return `已更新技能 "${name}"。`;
      }
      case 'patch': {
        if (args.old_string === undefined || args.new_string === undefined) {
          throw new Error('patch 需要 old_string 与 new_string');
        }
        ctx.skills.patch(name, args.old_string, args.new_string, args.replace_all ?? false);
        return `已 patch 技能 "${name}"。`;
      }
      case 'delete': {
        if (ctx.approval) {
          const r = await ctx.approval.confirm({ command: `skill:delete:${name}`, description: `删除技能 ${name}` });
          if (!r.allowed) return r.reason ?? '已取消删除。';
        }
        ctx.skills.delete(name);
        return `已删除技能 "${name}"。`;
      }
      default: {
        // 穷尽性保护:新增 action 而漏写 case 时,这里会编译报错(定位到枚举改动处)
        const _exhaustive: never = action;
        throw new Error(`未知 action: ${String(_exhaustive)}`);
      }
    }
  },
});
