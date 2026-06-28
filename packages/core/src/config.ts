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
  enabledToolsets?: string[];
  disabledToolsets?: string[];
  approvalMode?: 'manual' | 'off';
  skillNudgeInterval: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HermesConfig {
  const file = join(getHermesHome(env), 'config.yaml');
  const fromFile: Record<string, any> = existsSync(file) ? (parse(readFileSync(file, 'utf8')) ?? {}) : {};
  const parseList = (v: string | undefined, fileVal: unknown): string[] | undefined => {
    if (v !== undefined && v.trim() !== '') return v.split(',').map((s) => s.trim()).filter(Boolean);
    if (Array.isArray(fileVal)) return (fileVal as unknown[]).map(String);
    return undefined;
  };
  const parseInterval = (v: string | undefined, fileVal: unknown): number => {
    if (v !== undefined && v.trim() !== '') {
      const n = Number(v);
      return Number.isNaN(n) ? 10 : n;
    }
    if (typeof fileVal === 'number') return fileVal;
    return 10;
  };
  const provider = env.HERMES_PROVIDER ?? fromFile.provider ?? 'glm';
  const isTruthy = (v: string | undefined): boolean =>
    v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  const approvalMode: 'manual' | 'off' = isTruthy(env.HERMES_YOLO_MODE)
    ? 'off'
    : ((env.HERMES_APPROVAL_MODE ?? fromFile.approvalMode) === 'off' ? 'off' : 'manual');
  return {
    provider,
    model: env.HERMES_MODEL ?? fromFile.model ?? 'glm-4.6',
    apiKey: env.GLM_API_KEY ?? fromFile.apiKey ?? '',
    baseUrl: env.GLM_BASE_URL ?? fromFile.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4',
    maxIterations: Number(env.HERMES_MAX_ITERATIONS || fromFile.maxIterations || 25),
    enabledToolsets: parseList(env.HERMES_ENABLED_TOOLSETS, fromFile.enabledToolsets),
    disabledToolsets: parseList(env.HERMES_DISABLED_TOOLSETS, fromFile.disabledToolsets),
    approvalMode,
    skillNudgeInterval: parseInterval(env.HERMES_SKILL_NUDGE_INTERVAL, fromFile.skillNudgeInterval),
  };
}
