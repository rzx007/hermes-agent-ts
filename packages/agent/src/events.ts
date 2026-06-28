import type { CompletionResult } from '@hermes/providers';

export type LoopEvent =
  | { type: 'assistant_delta'; text: string }
  | { type: 'tool_call'; name: string; args: string }
  | { type: 'tool_result'; name: string; output: string }
  | { type: 'turn_done'; result: CompletionResult; iterations: number }
  | { type: 'error'; error: string };
