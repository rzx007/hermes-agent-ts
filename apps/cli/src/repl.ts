import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pc from 'picocolors';
import { runConversation, runSkillReview, shouldTriggerReview, type LoopDeps } from '@hermes/agent';
import { ApprovalGuard, type ToolContext } from '@hermes/tools';
import { allowlistPath } from '@hermes/core';

export interface ReplOptions { approvalMode: 'manual' | 'off'; skillNudgeInterval: number }

export async function repl(deps: LoopDeps, ctx: Omit<ToolContext, 'signal'>, options: ReplOptions) {
  const { db } = deps;
  let session = db.createSession({ source: 'cli', modelConfig: { provider: deps.provider.name, model: deps.model } });
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const guard = new ApprovalGuard({
    mode: options.approvalMode,
    allowlistPath: allowlistPath(),
    logger: ctx.logger,
    prompt: async ({ command, description }) => {
      console.log(pc.yellow(`\n⚠️ 危险命令:${description}`));
      console.log(pc.dim(`    ${command}`));
      const ans = (await rl.question(pc.cyan('  [o]nce / [s]ession / [a]lways / [d]eny ▸ '))).trim().toLowerCase();
      return ans === 'a' ? 'always' : ans === 's' ? 'session' : ans === 'o' ? 'once' : 'deny';
    },
  });

  // 后台自改进专用 guard:无 prompt → confirm() 必拒 → skill_manage delete 被挡(只增/精炼,不删)。
  // 用独立空 allowlist 路径,避免误读前台持久白名单里可能存在的 skill:delete:* 条目。
  const reviewGuard = new ApprovalGuard({
    mode: 'manual',
    allowlistPath: join(tmpdir(), 'hermes-review-noallow.json'),
    logger: ctx.logger,
  });
  const enabledTools = deps.toolNames ?? deps.registry.getToolNames();
  let inFlightReview: Promise<void> | null = null;

  // 注:SIGINT 硬退出不 await in-flight 自改进 review(与 /exit、/new 的 await 不对称);
  // 这是有意的 best-effort 取舍——技能写入是单次文件操作,被打断风险低,不值得为硬退出阻塞。
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
    if (line === '/exit') { if (inFlightReview) await inFlightReview; break; }
    if (line === '/help') { console.log('/new 新会话  /tools 查看启用工具  /exit 退出  /help 帮助'); continue; }
    if (line === '/tools') {
      const names = deps.toolNames ?? deps.registry.getToolNames();
      console.log(pc.dim(`启用的工具(${names.length}):`));
      console.log(names.join(', '));
      continue;
    }
    if (line === '/new') {
      if (inFlightReview) await inFlightReview;
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

    let turnIterations = -1;
    try {
      for await (const ev of runConversation(deps, session.id, line, { ...ctx, signal: controller.signal, approval: guard, memory: deps.memory, sessionDb: deps.db, skills: deps.skills })) {
        switch (ev.type) {
          case 'assistant_delta': stdout.write(ev.text); break;
          case 'tool_call': console.log(pc.dim(`\n⚙ ${ev.name}(${truncate(ev.args, 300)})`)); break;
          case 'tool_result': console.log(pc.dim(`↳ ${truncate(ev.output, 500)}`)); break;
          case 'turn_done': {
            const u = ev.result.usage;
            stdout.write('\n');
            if (u) console.log(pc.dim(`[tokens ${u.promptTokens}+${u.completionTokens}]`));
            turnIterations = ev.iterations;
            break;
          }
          case 'error': console.log(pc.red(`\n错误：${ev.error}`)); break;
        }
      }
    } finally {
      process.off('SIGINT', onSig);
    }

    // 后台技能自改进:正常收尾(非中断)、达阈值、且无 in-flight 时触发,不 await
    if (!controller.signal.aborted && turnIterations >= 0 && !inFlightReview
        && shouldTriggerReview(turnIterations, options.skillNudgeInterval, enabledTools)) {
      const snapshot = db.getMessages(session.id);
      const reviewCtx: ToolContext = { cwd: ctx.cwd, logger: ctx.logger, skills: deps.skills, approval: reviewGuard };
      inFlightReview = runSkillReview(
        { provider: deps.provider, registry: deps.registry, model: deps.model },
        snapshot, reviewCtx,
      )
        .then((sum) => { if (sum.actions.length) console.log(pc.dim(`\n💾 自改进:${sum.actions.join(' ')}`)); })
        .catch(() => { /* best-effort,不影响主流程 */ })
        .finally(() => { inFlightReview = null; });
    }
  }

  db.endSession(session.id);
  rl.close();
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…[截断]` : s;
}
