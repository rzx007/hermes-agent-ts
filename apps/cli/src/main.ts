#!/usr/bin/env node
import 'dotenv/config';
import { loadConfig, ensureHermesHome, sessionDbPath, SessionDB, createLogger } from '@hermes/core';
import { createProvider } from '@hermes/providers';
import { ToolRegistry, registerBuiltins } from '@hermes/tools';
import { repl } from './repl.js';

async function main() {
  const config = loadConfig();
  if (!config.apiKey) {
    console.error('缺少 API Key。请设置环境变量 GLM_API_KEY 或在 ~/.hermes/config.yaml 配置。');
    process.exit(1);
  }
  ensureHermesHome();
  const db = new SessionDB(sessionDbPath());
  const provider = createProvider(config);
  const registry = new ToolRegistry();
  registerBuiltins(registry);

  const deps = { db, provider, registry, model: config.model, maxIterations: config.maxIterations };
  await repl(deps, db, { cwd: process.cwd(), logger: createLogger('cli') });
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
