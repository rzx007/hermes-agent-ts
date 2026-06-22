import { readFileSync, writeFileSync } from 'node:fs';
import type { Logger } from '@hermes/core';

// 任何模式都阻止(连 off/yolo 都绕不过)——最致命的
const HARDLINE_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\b(\s+-{1,2}[a-z-]+)*\s+\/(\s|$)/i, '删除根目录'],
  [/\bmkfs\b/i, '格式化文件系统'],
  [/\bdd\b[^\n]*\bof=\/dev\/(?!null\b|zero\b)/i, 'dd 覆写块设备'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'fork bomb'],
  [/>\s*\/dev\/(sd|nvme|disk)/i, '写入块设备'],
];

// 命中即需审批(可被 off/yolo/白名单放行)
const DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-z]*\s+)*-[a-z]*r/i, '递归删除'],
  [/\brm\b[^\n]*--(recursive|force)\b/i, '递归/强制删除(长格式)'],
  [/\bfind\b[^\n]*\s-delete\b/i, 'find -delete 批量删除'],
  [/\bchmod\s+(-[a-z]*\s+)*(777|666|a\+w|o\+w)/i, '放开写权限'],
  [/\bchown\s+(-[a-z]*\s+)*-R\b/i, '递归改所有者'],
  [/\b(curl|wget)\b[^\n]*\|\s*(ba)?sh\b/i, '下载并执行'],
  [/\b(kill|pkill|killall)\b[^\n]*\b-9\b/i, '强制杀进程'],
  [/\bsystemctl\s+(stop|disable|mask)\b/i, '停用系统服务'],
  [/\bgit\b[^\n]*\bpush\b[^\n]*(--force|-f)\b/i, 'git 强推'],
  [/\b(tee\b[^\n]*|>>?\s*)\/etc\//i, '写 /etc'],
  [/\bsudo\b/i, 'sudo 提权'],
  [/>>?\s*~?\/?\.ssh\//i, '写 ~/.ssh'],
  [/\b(shutdown|reboot|halt)\b/i, '关机/重启'],
  [/\btruncate\b[^\n]*-s\s*0\b/i, '清空文件'],
];

export type DangerLevel = 'hardline' | 'dangerous' | 'safe';

export function detectDangerous(cmd: string): { level: DangerLevel; desc?: string } {
  for (const [re, desc] of HARDLINE_PATTERNS) {
    if (re.test(cmd)) return { level: 'hardline', desc };
  }
  for (const [re, desc] of DANGEROUS_PATTERNS) {
    if (re.test(cmd)) return { level: 'dangerous', desc };
  }
  return { level: 'safe' };
}

export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny';
export interface ApprovalRequest { command: string; description: string }

export interface ApprovalGuardOpts {
  mode: 'manual' | 'off';
  allowlistPath: string;
  prompt?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  logger?: Logger;
}

export class ApprovalGuard {
  private readonly mode: 'manual' | 'off';
  private readonly allowlistPath: string;
  private readonly prompt?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  private readonly logger?: Logger;
  private readonly sessionAllow = new Set<string>();
  private readonly persistentAllow: Set<string>;

  constructor(opts: ApprovalGuardOpts) {
    this.mode = opts.mode;
    this.allowlistPath = opts.allowlistPath;
    this.prompt = opts.prompt;
    this.logger = opts.logger;
    this.persistentAllow = this.load();
  }

  async check(command: string): Promise<{ allowed: boolean; reason?: string }> {
    const det = detectDangerous(command);
    if (det.level === 'hardline') {
      return { allowed: false, reason: `已阻止(hardline):${det.desc}。此类命令永不允许执行。` };
    }
    if (det.level === 'safe') return { allowed: true };
    // dangerous:
    if (this.mode === 'off') return { allowed: true };
    if (this.sessionAllow.has(command) || this.persistentAllow.has(command)) {
      return { allowed: true };
    }
    if (!this.prompt) {
      return { allowed: false, reason: `已阻止:危险命令(${det.desc})需要审批,但当前无交互审批通道。` };
    }
    let decision: ApprovalDecision;
    try {
      decision = await this.prompt({ command, description: det.desc! });
    } catch {
      decision = 'deny';
    }
    if (decision === 'deny') return { allowed: false, reason: '用户拒绝执行该命令。' };
    if (decision === 'session') this.sessionAllow.add(command);
    if (decision === 'always') {
      this.sessionAllow.add(command);
      this.persistentAllow.add(command);
      this.save();
    }
    return { allowed: true };
  }

  private load(): Set<string> {
    try {
      const raw = readFileSync(this.allowlistPath, 'utf8');
      const data = JSON.parse(raw) as { commands?: unknown };
      const cmds = Array.isArray(data.commands) ? data.commands.map(String) : [];
      return new Set(cmds);
    } catch (e) {
      this.logger?.warn(`读 allowlist 失败:${e instanceof Error ? e.message : String(e)}`);
      return new Set();
    }
  }

  private save(): void {
    try {
      writeFileSync(this.allowlistPath, JSON.stringify({ commands: [...this.persistentAllow] }, null, 2), 'utf8');
    } catch (e) {
      this.logger?.warn(`写 allowlist 失败:${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
