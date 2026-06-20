import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { getHermesHome } from './paths.js';

export interface HermesConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxIterations: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HermesConfig {
  const file = join(getHermesHome(env), 'config.yaml');
  const fromFile: Record<string, any> = existsSync(file) ? (parse(readFileSync(file, 'utf8')) ?? {}) : {};
  const provider = env.HERMES_PROVIDER ?? fromFile.provider ?? 'glm';
  return {
    provider,
    model: env.HERMES_MODEL ?? fromFile.model ?? 'glm-4.6',
    apiKey: env.GLM_API_KEY ?? fromFile.apiKey ?? '',
    baseUrl: env.GLM_BASE_URL ?? fromFile.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4',
    maxIterations: Number(env.HERMES_MAX_ITERATIONS || fromFile.maxIterations || 25),
  };
}
