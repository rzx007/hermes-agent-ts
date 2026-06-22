export function buildSystemPrompt(cwd: string, memoryBlock?: string): string {
  // TODO(阶段4): 注入技能 / 人格
  const parts = [
    '你是 Hermes，一个能够调用工具完成任务的 AI 代理。',
    `当前时间：${new Date().toISOString()}`,
    `当前工作目录：${cwd}`,
    '可用工具会以工具定义的形式提供。需要时调用它们，完成后用自然语言回答用户。',
  ];
  if (memoryBlock && memoryBlock.trim() !== '') {
    parts.push('', '以下是你的长期记忆(跨会话持久):', memoryBlock);
  }
  return parts.join('\n');
}
