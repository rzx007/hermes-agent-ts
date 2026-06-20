export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // 原始 JSON 字符串
}

export interface Message {
  role: Role;
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface Session {
  id: string;
  userId: string;
  title: string | null;
  source: string;
  startedAt: number;
  endedAt: number | null;
  parentSessionId: string | null;
  modelConfig: Record<string, unknown>;
}

export interface CreateSessionOpts {
  userId?: string;
  title?: string | null;
  source?: string;
  modelConfig?: Record<string, unknown>;
}
