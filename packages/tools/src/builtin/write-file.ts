import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../registry.js';

export const writeFileTool = defineTool({
  name: 'write_file',
  description: '写入（覆盖）文本文件，自动创建父目录。返回写入字节数。',
  toolset: 'core',
  schema: z.object({ path: z.string(), content: z.string() }),
  handler: async ({ path, content }, ctx) => {
    const full = resolve(ctx.cwd, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
    return `已写入 ${Buffer.byteLength(content, 'utf8')} 字节到 ${path}`;
  },
});
