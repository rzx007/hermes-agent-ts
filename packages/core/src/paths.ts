import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export function getHermesHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERMES_HOME) return env.HERMES_HOME;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return join(home, '.hermes');
}

export function ensureHermesHome(env: NodeJS.ProcessEnv = process.env): string {
  const dir = getHermesHome(env);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sessionDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getHermesHome(env), 'sessions.db');
}
