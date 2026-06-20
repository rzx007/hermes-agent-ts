import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../registry.js';

const MAX_BYTES = 100 * 1024;

export const readFileTool = defineTool({
  name: 'read_file',
  description: '读取文本文件内容，返回带行号的文本。超过 100KB 会截断。',
  toolset: 'core',
  schema: z.object({ path: z.string().describe('相对或绝对文件路径') }),
  handler: async ({ path }, ctx) => {
    const full = resolve(ctx.cwd, path);
    const text = readFileSync(full, 'utf8');
    const buf = Buffer.from(text, 'utf8');
    let body = text;
    let truncated = false;
    if (buf.byteLength > MAX_BYTES) {
      body = buf.subarray(0, MAX_BYTES).toString('utf8');
      truncated = true;
    }
    const numbered = body.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
    return truncated ? `${numbered}\n... [已截断，超过 100KB]` : numbered;
  },
});
