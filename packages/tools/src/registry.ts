import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Logger } from '@hermes/core';
import type { ToolSchema } from '@hermes/providers';

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  logger: Logger;
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

  async call(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
    const def = this.tools.get(name);
    if (!def) return `Error: 未知工具 "${name}"`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs || '{}');
    } catch {
      return `Error: 工具 "${name}" 入参不是合法 JSON: ${rawArgs}`;
    }
    const result = def.schema.safeParse(parsed);
    if (!result.success) {
      return `Error: 工具 "${name}" 入参校验失败: ${result.error.message}`;
    }
    try {
      return await def.handler(result.data, ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: 工具 "${name}" 执行失败: ${msg}`;
    }
  }
}
