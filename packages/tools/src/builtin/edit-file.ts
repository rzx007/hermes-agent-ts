import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../registry.js';

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export const editFileTool = defineTool({
  name: 'edit_file',
  description: '精确字符串替换编辑文件。oldString 必须在文件中唯一(或设 replaceAll)。',
  toolset: 'file',
  schema: z.object({
    path: z.string(),
    oldString: z.string().describe('要被替换的精确文本'),
    newString: z.string().describe('替换后的文本'),
    replaceAll: z.boolean().optional().describe('替换全部匹配,默认 false'),
  }),
  handler: async ({ path, oldString, newString, replaceAll }, ctx) => {
    const full = resolve(ctx.cwd, path);
    const content = readFileSync(full, 'utf8');
    const n = countOccurrences(content, oldString);
    if (n === 0) {
      throw new Error(`未找到 oldString,无法替换。请确认文本(含空白)与文件内容完全一致。`);
    }
    if (n > 1 && !replaceAll) {
      throw new Error(`oldString 不唯一(出现 ${n} 处)。请提供更长的上下文使其唯一,或设 replaceAll: true。`);
    }
    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);
    writeFileSync(full, updated, 'utf8');
    return `已在 ${path} 替换 ${replaceAll ? n : 1} 处`;
  },
});
