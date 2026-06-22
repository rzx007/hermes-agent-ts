import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fg from 'fast-glob';
import { z } from 'zod';
import { defineTool } from '../registry.js';

const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**'];
const MAX_MATCHES = 200;
const MAX_BYTES = 50 * 1024;

export const searchFilesTool = defineTool({
  name: 'search_files',
  description: '搜索文件(忽略 node_modules/.git/dist 与 dotfile)。content 模式:按正则搜内容,返回 路径:行号: 匹配行。filename 模式:按 glob 搜文件名。',
  toolset: 'file',
  schema: z.object({
    pattern: z.string().describe('content 模式=正则;filename 模式=glob(如 **/*.ts 或 *foo*)'),
    path: z.string().optional().describe('搜索根目录,默认 cwd'),
    mode: z.enum(['content', 'filename']).optional().describe('默认 content'),
    glob: z.string().optional().describe('content 模式下限定文件范围,如 **/*.ts'),
  }),
  handler: async ({ pattern, path, mode = 'content', glob }, ctx) => {
    const root = resolve(ctx.cwd, path ?? '.');

    if (mode === 'filename') {
      const files = await fg(pattern, { cwd: root, ignore: IGNORE, dot: false, onlyFiles: true });
      if (files.length === 0) return '无匹配';
      const shown = files.slice(0, MAX_MATCHES);
      const suffix = files.length > shown.length ? `\n... [共 ${files.length} 个,已截断]` : '';
      return shown.join('\n') + suffix;
    }

    // content 模式
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (e) {
      throw new Error(`无效正则: ${(e as Error).message}`);
    }
    const files = await fg(glob ?? '**/*', { cwd: root, ignore: IGNORE, dot: false, onlyFiles: true });
    const lines: string[] = [];
    let bytes = 0;
    let truncated = false;
    for (const rel of files) {
      let text: string;
      try {
        text = readFileSync(resolve(root, rel), 'utf8');
      } catch {
        continue; // 二进制/不可读跳过
      }
      const fileLines = text.split('\n');
      for (let i = 0; i < fileLines.length; i++) {
        if (regex.test(fileLines[i]!)) {
          const entry = `${rel}:${i + 1}: ${fileLines[i]!.trim()}`;
          const entryBytes = Buffer.byteLength(entry, 'utf8');
          if (lines.length >= MAX_MATCHES || bytes + entryBytes > MAX_BYTES) {
            truncated = true;
            break;
          }
          lines.push(entry);
          bytes += entryBytes;
        }
      }
      if (truncated) break;
    }
    if (lines.length === 0) return '无匹配';
    return lines.join('\n') + (truncated ? '\n... [结果过多,已截断]' : '');
  },
});
