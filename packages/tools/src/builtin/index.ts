import type { ToolRegistry } from '../registry.js';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { terminalTool } from './terminal.js';

export const builtinTools = [readFileTool, writeFileTool, terminalTool];

export function registerBuiltins(registry: ToolRegistry): void {
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(terminalTool);
}
