import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import pc from 'picocolors';
import { runConversation, type LoopDeps } from '@hermes/agent';
import type { ToolContext } from '@hermes/tools';

export async function repl(deps: LoopDeps, ctx: Omit<ToolContext, 'signal'>) {
  const { db } = deps;
  let session = db.createSession({ source: 'cli', modelConfig: { provider: deps.provider.name, model: deps.model } });
  const rl = readline.createInterface({ input: stdin, output: stdout });

  rl.on('SIGINT', () => {
    console.log(pc.yellow('\n退出 Hermes'));
    db.endSession(session.id);
    rl.close();
    process.exit(0);
  });

  console.log(pc.bold(`Hermes TS · 模型 ${deps.model} · 会话 ${session.id.slice(0, 8)}`));
  console.log(pc.dim('输入对话内容；/new 新会话，/help 帮助，/exit 退出。'));

  for (;;) {
    const line = (await rl.question(pc.cyan('\n› '))).trim();
    if (!line) continue;
    if (line === '/exit') break;
    if (line === '/help') { console.log('/new 新会话  /tools 查看启用工具  /exit 退出  /help 帮助'); continue; }
    if (line === '/tools') {
      const names = deps.toolNames ?? deps.registry.getToolNames();
      console.log(pc.dim(`启用的工具(${names.length}):`));
      console.log(names.join(', '));
      continue;
    }
    if (line === '/new') {
      db.endSession(session.id);
      session = db.createSession({ source: 'cli', modelConfig: { provider: deps.provider.name, model: deps.model } });
      console.log(pc.dim(`新会话 ${session.id.slice(0, 8)}`));
      continue;
    }

    const controller = new AbortController();
    let interrupts = 0;
    const onSig = () => {
      if (++interrupts >= 2) { console.log('\n中断退出'); process.exit(0); }
      controller.abort();
      console.log(pc.yellow('\n[已中断当前轮，再次 Ctrl+C 退出]'));
    };
    process.on('SIGINT', onSig);

    try {
      for await (const ev of runConversation(deps, session.id, line, { ...ctx, signal: controller.signal })) {
        switch (ev.type) {
          case 'assistant_delta': stdout.write(ev.text); break;
          case 'tool_call': console.log(pc.dim(`\n⚙ ${ev.name}(${truncate(ev.args, 300)})`)); break;
          case 'tool_result': console.log(pc.dim(`↳ ${truncate(ev.output, 500)}`)); break;
          case 'turn_done': {
            const u = ev.result.usage;
            stdout.write('\n');
            if (u) console.log(pc.dim(`[tokens ${u.promptTokens}+${u.completionTokens}]`));
            break;
          }
          case 'error': console.log(pc.red(`\n错误：${ev.error}`)); break;
        }
      }
    } finally {
      process.off('SIGINT', onSig);
    }
  }

  db.endSession(session.id);
  rl.close();
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…[截断]` : s;
}
