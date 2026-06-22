// 任何模式都阻止(连 off/yolo 都绕不过)——最致命的
const HARDLINE_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f?[a-z]*\s+\/(\s|$)/i, '递归删除根目录'],
  [/\bmkfs\b/i, '格式化文件系统'],
  [/\bdd\b[^\n]*\bof=\/dev\//i, 'dd 覆写块设备'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'fork bomb'],
  [/>\s*\/dev\/(sd|nvme|disk)/i, '写入块设备'],
];

// 命中即需审批(可被 off/yolo/白名单放行)
const DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-z]*\s+)*-[a-z]*r/i, '递归删除'],
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
