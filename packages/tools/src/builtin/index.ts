import type { ToolRegistry } from '../registry.js';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { terminalTool } from './terminal.js';
import { editFileTool } from './edit-file.js';
import { searchFilesTool } from './search-files.js';
import { listDirTool } from './list-dir.js';
import { memoryTool } from './memory.js';

export const builtinTools = [
  readFileTool, writeFileTool, terminalTool,
  editFileTool, searchFilesTool, listDirTool,
  memoryTool,
];

export function registerBuiltins(registry: ToolRegistry): void {
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(terminalTool);
  registry.register(editFileTool);
  registry.register(searchFilesTool);
  registry.register(listDirTool);
  registry.register(memoryTool);
}
