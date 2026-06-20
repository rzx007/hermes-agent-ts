import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ToolDef } from '../registry.js';

const MAX_BYTES = 100 * 1024;

export const readFileTool: ToolDef = {
  name: 'read_file',
  description: '读取文本文件内容，返回带行号的文本。超过 100KB 会截断。',
  toolset: 'core',
  schema: z.object({ path: z.string().describe('相对或绝对文件路径') }),
  handler: async ({ path }, ctx) => {
    const full = resolve(ctx.cwd, path as string);
    let text = readFileSync(full, 'utf8');
    let truncated = false;
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
      text = text.slice(0, MAX_BYTES);
      truncated = true;
    }
    const numbered = text.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
    return truncated ? `${numbered}\n... [已截断，超过 100KB]` : numbered;
  },
};
