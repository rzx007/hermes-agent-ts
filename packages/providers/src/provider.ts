import type { Message, ToolCall } from '@hermes/core';

export interface ToolSchema {
  name: string;
  description: string;
  parameters: object; // JSON Schema
}

export interface CompletionRequest {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  signal?: AbortSignal;
}

export interface CompletionChunk {
  contentDelta?: string;
  toolCallDelta?: { index: number; id?: string; name?: string; argsDelta?: string };
}

export interface CompletionResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface Provider {
  readonly name: string;
  complete(req: CompletionRequest): AsyncIterable<CompletionChunk>;
  aggregate(chunks: AsyncIterable<CompletionChunk>): Promise<CompletionResult>;
}
