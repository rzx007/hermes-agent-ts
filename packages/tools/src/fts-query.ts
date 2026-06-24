/**
 * 把用户查询转成 FTS5 字面短语:整体用双引号包裹,内部双引号转义为 ""。
 * 这样彻底绕开 FTS5 的 AND/OR/NOT 等操作符解析,杜绝注入。
 * 配合 trigram tokenizer 做子串匹配(调用方需保证查询 >=3 字符)。
 */
export function sanitizeFtsQuery(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}
