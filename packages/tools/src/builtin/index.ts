import type { ToolRegistry } from '../registry.js';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { terminalTool } from './terminal.js';
import { editFileTool } from './edit-file.js';
import { searchFilesTool } from './search-files.js';
import { listDirTool } from './list-dir.js';
import { memoryTool } from './memory.js';
import { sessionSearchTool } from './session-search.js';
import { skillViewTool } from './skills.js';

export const builtinTools = [
  readFileTool, writeFileTool, terminalTool,
  editFileTool, searchFilesTool, listDirTool,
  memoryTool, sessionSearchTool, skillViewTool,
];

export function registerBuiltins(registry: ToolRegistry): void {
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(terminalTool);
  registry.register(editFileTool);
  registry.register(searchFilesTool);
  registry.register(listDirTool);
  registry.register(memoryTool);
  registry.register(sessionSearchTool);
  registry.register(skillViewTool);
}
