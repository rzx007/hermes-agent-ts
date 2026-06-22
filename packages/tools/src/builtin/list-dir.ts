import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../registry.js';

export const listDirTool = defineTool({
  name: 'list_dir',
  description: '列出目录的直接条目(不递归)。目录名以 / 结尾。',
  toolset: 'file',
  schema: z.object({ path: z.string().optional().describe('默认 cwd') }),
  handler: async ({ path }, ctx) => {
    const dir = resolve(ctx.cwd, path ?? '.');
    const entries = readdirSync(dir, { withFileTypes: true });
    const names = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return names.length ? names.join('\n') : '(空目录)';
  },
});
