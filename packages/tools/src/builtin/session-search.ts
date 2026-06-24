import { z } from 'zod';
import { defineTool } from '../registry.js';
import { sanitizeFtsQuery } from '../fts-query.js';

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export const sessionSearchTool = defineTool({
  name: 'session_search',
  description:
    '搜索过往会话历史。给 query 全文搜索(子串,≥3 字符,支持中文);省略 query 则浏览最近会话。用于回忆之前聊过/做过什么。',
  toolset: 'search',
  schema: z.object({
    query: z.string().optional().describe('搜索词(≥3 字符);省略=浏览最近会话'),
    limit: z.number().int().positive().max(50).optional().describe('结果数,默认 10,上限 50'),
  }),
  handler: async ({ query, limit = 10 }, ctx) => {
    if (!ctx.sessionDb) return '会话搜索不可用。';
    if (query === undefined || query.trim() === '') {
      const briefs = ctx.sessionDb.browseSessions(limit);
      if (briefs.length === 0) return '暂无历史会话。';
      return briefs
        .map((b) => `· ${b.id.slice(0, 8)} ${new Date(b.startedAt).toISOString()}  ${truncate(b.preview, 80)}`)
        .join('\n');
    }
    if (query.trim().length < 3) return '搜索词至少 3 个字符。';
    const hits = ctx.sessionDb.searchMessages(sanitizeFtsQuery(query), limit * 3);
    const bySession = new Map<string, (typeof hits)[number]>();
    for (const h of hits) {
      if (!bySession.has(h.sessionId)) bySession.set(h.sessionId, h);
    }
    const top = [...bySession.values()].slice(0, limit);
    if (top.length === 0) return '无匹配。';
    return top
      .map((h) => `· ${h.sessionId.slice(0, 8)} [${h.role}] ${new Date(h.createdAt).toISOString()}\n  ${h.snippet}`)
      .join('\n');
  },
});
