// 批量导入的纯函数：分片、解析文本行、分组标题命名、groupKey 生成。
// 刻意不依赖 React / API 客户端，方便单测（见 __tests__/batch-media.test.ts）。

/** 批量导入单请求条数上限，与服务端 BATCH_FROM_URLS_MAX_ITEMS 对齐。 */
export const BATCH_MEDIA_MAX_ITEMS = 20;

export interface BatchUrlLine {
  url: string;
  /** 行里 "URL | 标题" 的标题部分；没写时为 undefined */
  title?: string;
}

/**
 * 解析批量 URL 文本：每行一个 URL，或 "URL | 标题"。
 * 空行跳过；标题取第一个 "|" 后的部分并 trim，没写标题时不设 title。
 */
export function parseBatchUrlLines(text: string): BatchUrlLine[] {
  const lines: BatchUrlLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sep = line.indexOf("|");
    if (sep === -1) {
      lines.push({ url: line });
      continue;
    }
    const url = line.slice(0, sep).trim();
    const title = line.slice(sep + 1).trim();
    if (!url) continue;
    lines.push(title ? { url, title } : { url });
  }
  return lines;
}

/** 按 size 分片，最后一片可能不足 size；size 非法时回退到 BATCH_MEDIA_MAX_ITEMS。 */
export function chunkBatchItems<T>(items: T[], size: number = BATCH_MEDIA_MAX_ITEMS): T[][] {
  const per = Number.isInteger(size) && size > 0 ? size : BATCH_MEDIA_MAX_ITEMS;
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += per) {
    chunks.push(items.slice(i, i + per));
  }
  return chunks;
}

export interface BatchUrlItem {
  url: string;
  title?: string;
  alt?: string;
}

/**
 * 给未指定标题的条目按「分组标题 (i/N)」命名（i 为全局序号，N 为整批总数，
 * 不是分片内序号——分片请求共用这份已命名好的条目，所以跨分片序号不重排）。
 * 已有标题的条目原样保留；没填分组标题时，未命名条目保持无标题。
 */
export function titleBatchItems(
  items: BatchUrlLine[],
  groupTitle: string,
): BatchUrlItem[] {
  const base = groupTitle.trim();
  return items.map((item, index) => {
    if (item.title) {
      return { url: item.url, title: item.title };
    }
    if (!base) {
      return { url: item.url };
    }
    return { url: item.url, title: `${base} (${index + 1}/${items.length})` };
  });
}

/**
 * 客户端生成一次的 groupKey：分片请求共用它，同一批跨分片聚成一组。
 * 只含字母数字与冒号，服务端 sanitizeGroupKey 原样保留（不加前缀、不截断）。
 */
export function generateBatchGroupKey(): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `batch:${stamp}${rand}`.slice(0, 100);
}
