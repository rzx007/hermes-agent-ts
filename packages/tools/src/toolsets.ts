export interface Toolset {
  description: string;
  tools?: string[];
  includes?: string[];
}

export const TOOLSETS: Record<string, Toolset> = {
  file: {
    description: '文件读写/编辑/搜索',
    tools: ['read_file', 'write_file', 'edit_file', 'search_files', 'list_dir'],
  },
  terminal: {
    description: '执行 shell 命令',
    tools: ['terminal'],
  },
  memory: {
    description: '长期记忆读写',
    tools: ['memory'],
  },
  core: {
    description: '核心工具集',
    includes: ['file', 'terminal', 'memory'],
  },
};

// 注意:'all' 与 '*' 是 resolveToolset 的保留名,不要作为 TOOLSETS 的键(否则该分支会无限递归)。
// 递归展开 toolset 名 → 工具名数组。支持 'all'/'*';未知名返回 [];visited 做环检测。
export function resolveToolset(name: string, visited: Set<string> = new Set()): string[] {
  if (name === 'all' || name === '*') {
    const acc = new Set<string>();
    // 每个顶层 toolset 用独立 visited 完整展开,避免共享 visited 在未来
    // 「某工具仅经 includes 可达」的形状下被错误跳过
    for (const key of Object.keys(TOOLSETS)) {
      for (const t of resolveToolset(key, new Set())) acc.add(t);
    }
    return [...acc];
  }
  if (visited.has(name)) return [];
  visited.add(name);
  const ts = TOOLSETS[name];
  if (!ts) return [];
  const acc = new Set<string>(ts.tools ?? []);
  for (const inc of ts.includes ?? []) {
    for (const t of resolveToolset(inc, visited)) acc.add(t);
  }
  return [...acc];
}

// 计算最终启用的工具名。
// - enabled undefined → 全部已注册工具
// - 否则 union(resolveToolset(每个 enabled)) 再 difference(resolveToolset(每个 disabled))
// - 末尾与 registeredToolNames 取交集(未注册的工具忽略 → 前向兼容)
export function computeEnabledTools(
  opts: { enabled?: string[]; disabled?: string[] },
  registeredToolNames: string[],
): string[] {
  const registered = new Set(registeredToolNames);
  let selected: Set<string>;
  if (opts.enabled === undefined) {
    selected = new Set(registeredToolNames);
  } else {
    selected = new Set<string>();
    for (const name of opts.enabled) {
      for (const t of resolveToolset(name)) selected.add(t);
    }
  }
  for (const name of opts.disabled ?? []) {
    for (const t of resolveToolset(name)) selected.delete(t);
  }
  return [...selected].filter((t) => registered.has(t));
}
