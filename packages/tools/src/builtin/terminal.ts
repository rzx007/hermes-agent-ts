import { spawn } from 'node:child_process';
import { z } from 'zod';
import { defineTool } from '../registry.js';

export const terminalTool = defineTool({
  name: 'terminal',
  description: '在 local shell（bash）执行命令，返回 stdout/stderr 与退出码。',
  toolset: 'core',
  schema: z.object({
    command: z.string().describe('要执行的 shell 命令'),
    timeout: z.number().optional().describe('超时毫秒数，默认 120000'),
  }),
  handler: ({ command, timeout = 120_000 }, ctx) =>
    new Promise<string>((resolve) => {
      const child = spawn('bash', ['-c', command], { cwd: ctx.cwd });
      if (!child.stdout || !child.stderr) {
        resolve('Error: 无法获取子进程的 stdout/stderr 流');
        return;
      }
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeout);
      const onAbort = () => child.kill('SIGKILL');
      ctx.signal?.addEventListener('abort', onAbort);
      if (ctx.signal?.aborted) child.kill('SIGKILL');

      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        if (timedOut) {
          resolve(`[timeout] 命令超过 ${timeout}ms 被终止\nstdout:\n${stdout}\nstderr:\n${stderr}`);
          return;
        }
        const parts: string[] = [];
        if (stdout) parts.push(`stdout:\n${stdout}`);
        if (stderr) parts.push(`stderr:\n${stderr}`);
        parts.push(`exit code: ${code ?? -1}`);
        resolve(parts.join('\n'));
      });
    }),
});
