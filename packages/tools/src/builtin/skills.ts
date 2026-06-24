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
