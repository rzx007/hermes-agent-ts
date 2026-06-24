import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Logger } from '@hermes/core';
import type { ToolSchema } from '@hermes/providers';
import type { ApprovalGuard } from './approval.js';
import type { MemoryStore, SessionDB } from '@hermes/core';

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  logger: Logger;
  approval?: ApprovalGuard;
  memory?: MemoryStore;
  sessionDb?: SessionDB;
}

export interface ToolDef<T extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  toolset: string;
  schema: T;
  handler: (args: z.infer<T>, ctx: ToolContext) => Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register<T extends z.ZodTypeAny>(def: ToolDef<T>): void {
    this.tools.set(def.name, def as unknown as ToolDef);
  }

  has(name: string): boolean { return this.tools.has(name); }

  getToolNames(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * 获取工具的 JSON Schema 定义
   * 
   * 将注册的工具转换为符合 OpenAPI 3.0 规范的 JSON Schema 格式，用于工具描述和参数验证。
   * 如果指定了工具名称列表，则只返回对应工具的 schema；否则返回所有已注册工具的 schema。
   * 
   * @param names - 可选的工具名称数组，用于筛选特定的工具。如果未提供或为空，则返回所有工具的 schema
   * @returns 工具 schema 数组，每个元素包含工具名称、描述和 OpenAPI 3.0 格式的参数定义
   */
  getSchemas(names?: string[]): ToolSchema[] {
    const defs = names
      ? names.map((n) => this.tools.get(n)).filter((d): d is ToolDef => !!d)
      : [...this.tools.values()];
    return defs.map((d) => ({
      name: d.name,
      description: d.description,
      parameters: zodToJsonSchema(d.schema, { target: 'openApi3' }) as object,
    }));
  }

  /**
   * 调用指定的工具并执行其处理逻辑
   * 
   * 该方法负责解析工具参数、验证参数格式、执行工具处理器，并返回执行结果或错误信息。
   * 完整的执行流程包括：查找工具定义、解析 JSON 参数、Zod schema 校验、执行处理器、捕获异常。
   * 
   * @param name - 要调用的工具名称
   * @param rawArgs - 工具的原始参数字符串，应为合法的 JSON 格式
   * @param ctx - 工具执行的上下文对象，包含工作目录、中止信号和日志记录器
   * @returns 工具执行结果字符串，成功时返回处理器的输出，失败时返回格式化的错误信息
   */
  async call(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
    const def = this.tools.get(name);
    if (!def) return `Error: 未知工具 "${name}"`;

    // 解析原始参数为 JSON 对象
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs || '{}');
    } catch {
      return `Error: 工具 "${name}" 入参不是合法 JSON: ${rawArgs}`;
    }

    // 使用 Zod schema 验证参数格式和类型
    const result = def.schema.safeParse(parsed);
    if (!result.success) {
      return `Error: 工具 "${name}" 入参校验失败: ${result.error.message}`;
    }

    // 执行工具处理器并捕获可能的异常
    try {
      return await def.handler(result.data, ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: 工具 "${name}" 执行失败: ${msg}`;
    }
  }
}

// 用于定义工具时保留 schema 的具体类型，让 handler 的 args 得到精确推断
export function defineTool<T extends z.ZodTypeAny>(def: ToolDef<T>): ToolDef<T> {
  return def;
}
