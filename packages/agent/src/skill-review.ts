import { v4 as uuid } from 'uuid';
import type { Message } from '@hermes/core';
import type { Provider, CompletionChunk } from '@hermes/providers';
import type { ToolRegistry, ToolContext } from '@hermes/tools';

export interface ReviewDeps {
  provider: Provider;
  registry: ToolRegistry;
  model: string;
  maxIterations?: number; // 默认 16
}

export interface ReviewSummary {
  actions: string[];   // 成功的 skill_manage 结果串
  iterations: number;  // 实际跑的工具轮数
  error?: string;      // best-effort：内部异常记此，不外抛
}

const REVIEW_TOOLS = ['skill_view', 'skill_manage'];
// 注意:与 @hermes/tools builtin/skills.ts 中 skill_manage 的成功返回串耦合(已创建/已更新/已 patch/已删除…)。
// 若改动那边的返回文案,这里需同步,否则自改进动作将不被记录(无测试跨包捕获此耦合)。
const SUCCESS_PREFIXES = ['已创建', '已更新', '已 patch', '已删除'] as const;

const REVIEW_PROMPT = `你是 Hermes 的技能库维护者。下面是一段刚结束的对话，请复盘并在必要时更新技能库（程序性知识）。

要主动——多数会话至少能产出一条小更新。出现以下任一信号就动手：
1. 用户纠正了你的风格/语气/做法 → 把该偏好写进相关技能；
2. 出现了非平凡的技巧/修复/绕法 → 记下供日后复用；
3. 某个已加载或相关技能已过时/缺失 → 立即修正。

优先级：先 patch 已有技能，其次新建“类级”技能（名字要泛化，能覆盖一类任务，不能是一次性任务名/PR 号/报错串）。
不要记录：环境瞬时错误、对工具的否定断言、一次性任务叙事。
用 skill_view 查看现有技能正文，用 skill_manage（create/edit/patch）写入。若确实没有值得保存的，直接回复“无需更新”，不要硬凑。`;

const REVIEW_INSTRUCTION = '复盘上面的对话并据此更新技能库（必要时先 skill_view 查看，再用 skill_manage 创建/编辑/patch）。没有值得保存的就回复“无需更新”。';

/** 后台技能自改进 review：独立工具循环，不持久化、不流式输出、只给技能工具。best-effort，绝不外抛。 */
export async function runSkillReview(
  deps: ReviewDeps,
  snapshot: Message[],
  ctx: ToolContext,
): Promise<ReviewSummary> {
  const max = deps.maxIterations ?? 16;
  const actions: string[] = [];
  let iterations = 0;
  try {
    const messages: Message[] = [
      { role: 'system', content: REVIEW_PROMPT },
      ...snapshot,
      { role: 'user', content: REVIEW_INSTRUCTION },
    ];
    const tools = deps.registry.getSchemas(REVIEW_TOOLS);
    for (let i = 0; i < max; i++) {
      if (ctx.signal?.aborted) break;
      const captured: CompletionChunk[] = [];
      for await (const chunk of deps.provider.complete({ model: deps.model, messages, tools, signal: ctx.signal })) {
        captured.push(chunk); // 丢弃 delta（后台不向用户输出）
      }
      const result = await deps.provider.aggregate((async function* () { for (const c of captured) yield c; })());
      messages.push({
        role: 'assistant',
        content: result.content,
        toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
      });
      if (result.toolCalls.length === 0) break;
      iterations++;
      for (const call of result.toolCalls) {
        const output = await deps.registry.call(call.name, call.arguments, ctx);
        messages.push({ role: 'tool', content: output, toolCallId: call.id || uuid(), name: call.name });
        if (call.name === 'skill_manage' && SUCCESS_PREFIXES.some((p) => output.startsWith(p))) {
          actions.push(output);
        }
      }
    }
    return { actions, iterations };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.logger.warn(`技能自改进 review 失败:${msg}`);
    return { actions, iterations, error: msg };
  }
}

/** 是否触发自改进：阈值>0、本轮工具迭代数达标、skill_manage 在启用工具内。 */
export function shouldTriggerReview(iterations: number, interval: number, enabledTools: string[]): boolean {
  return interval > 0 && iterations >= interval && enabledTools.includes('skill_manage');
}
