#!/usr/bin/env node
import 'dotenv/config';
import { loadConfig, ensureHermesHome, sessionDbPath, SessionDB, createLogger, MemoryStore, memoriesDir } from '@hermes/core';
import { createProvider } from '@hermes/providers';
import { ToolRegistry, registerBuiltins, computeEnabledTools, TOOLSETS } from '@hermes/tools';
import { repl } from './repl.js';

async function main() {
  const config = loadConfig();
  if (!config.apiKey) {
    console.error('缺少 API Key。请设置环境变量 GLM_API_KEY 或在 ~/.hermes-ts/config.yaml 配置。');
    process.exit(1);
  }
  ensureHermesHome();
  const memory = new MemoryStore(memoriesDir());
  const db = new SessionDB(sessionDbPath());
  process.on('exit', () => { try { db.close(); } catch { /* already closed */ } });
  const provider = createProvider(config);
  const logger = createLogger('cli');
  const registry = new ToolRegistry();
  registerBuiltins(registry);

  const toolNames = computeEnabledTools(
    { enabled: config.enabledToolsets, disabled: config.disabledToolsets },
    registry.getToolNames(),
  );
  // 对配置中不存在的 toolset 名给出警告(computeEnabledTools 会静默跳过它们)
  const knownToolsets = new Set(Object.keys(TOOLSETS));
  for (const name of [...(config.enabledToolsets ?? []), ...(config.disabledToolsets ?? [])]) {
    if (name !== 'all' && name !== '*' && !knownToolsets.has(name)) {
      logger.warn(`未知 toolset "${name}",已忽略。可用:${[...knownToolsets].join(', ')}`);
    }
  }

  const deps = { db, provider, registry, model: config.model, maxIterations: config.maxIterations, toolNames, memory };
  try {
    await repl(deps, { cwd: process.cwd(), logger }, { approvalMode: config.approvalMode ?? 'manual' });
  } finally {
    db.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
