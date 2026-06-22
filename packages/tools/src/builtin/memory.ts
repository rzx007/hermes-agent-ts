import { z } from 'zod';
import { defineTool } from '../registry.js';

export const memoryTool = defineTool({
  name: 'memory',
  description:
    '保存/更新长期记忆。WHEN:用户表达偏好、纠正、个人信息,或你学到关于其环境/约定/工作流的稳定事实时主动保存。优先级:用户偏好&纠正 > 环境事实 > 流程。target=memory 存你的笔记,user 存用户画像。',
  toolset: 'memory',
  schema: z.object({
    action: z.enum(['add', 'replace', 'remove']),
    target: z.enum(['memory', 'user']),
    content: z.string().optional().describe('add/replace 的内容'),
    oldText: z.string().optional().describe('replace/remove 定位用的子串'),
  }),
  handler: async ({ action, target, content, oldText }, ctx) => {
    if (!ctx.memory) return '记忆系统不可用。';
    if (action === 'add') {
      if (content === undefined) throw new Error('add 需要 content 参数。');
      ctx.memory.add(target, content);
      return `已向 ${target} 添加 1 条记忆。`;
    }
    if (action === 'replace') {
      if (oldText === undefined || content === undefined) {
        throw new Error('replace 需要 oldText 与 content 参数。');
      }
      ctx.memory.replace(target, oldText, content);
      return `已更新 ${target} 中的记忆。`;
    }
    // remove
    if (oldText === undefined) throw new Error('remove 需要 oldText 参数。');
    ctx.memory.remove(target, oldText);
    return `已从 ${target} 删除 1 条记忆。`;
  },
});
