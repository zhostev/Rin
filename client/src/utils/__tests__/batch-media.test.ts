import { describe, expect, it } from "bun:test";
import {
  BATCH_MEDIA_MAX_ITEMS,
  chunkBatchItems,
  generateBatchGroupKey,
  parseBatchUrlLines,
  titleBatchItems,
} from "../batch-media";

describe("parseBatchUrlLines", () => {
  it("每行一个 URL，空行跳过", () => {
    expect(parseBatchUrlLines("https://a.example/1.jpg\n\nhttps://a.example/2.jpg\n")).toEqual([
      { url: "https://a.example/1.jpg" },
      { url: "https://a.example/2.jpg" },
    ]);
  });
  it("“URL | 标题”取第一个 | 为分隔符，标题 trim", () => {
    expect(parseBatchUrlLines("https://a.example/1.jpg | 封面图")).toEqual([
      { url: "https://a.example/1.jpg", title: "封面图" },
    ]);
  });
  it("只有 URL 没有标题时不设 title，空 URL 行跳过", () => {
    expect(parseBatchUrlLines("  | 只有标题\nhttps://a.example/1.jpg |")).toEqual([
      { url: "https://a.example/1.jpg" },
    ]);
  });
  it("CRLF 换行也能解析", () => {
    expect(parseBatchUrlLines("https://a.example/1.jpg\r\nhttps://a.example/2.jpg")).toHaveLength(2);
  });
});

describe("chunkBatchItems", () => {
  it("默认按 20 条分片", () => {
    expect(BATCH_MEDIA_MAX_ITEMS).toBe(20);
    const items = Array.from({ length: 45 }, (_, i) => i);
    const chunks = chunkBatchItems(items);
    expect(chunks.map((c) => c.length)).toEqual([20, 20, 5]);
  });
  it("不足一片时只有一片，空数组返回空", () => {
    expect(chunkBatchItems([1, 2])).toEqual([[1, 2]]);
    expect(chunkBatchItems([])).toEqual([]);
  });
});

describe("titleBatchItems", () => {
  it("未命名条目按全局序号命名，已命名条目原样保留", () => {
    const out = titleBatchItems(
      [{ url: "u1" }, { url: "u2", title: "自定" }, { url: "u3" }],
      "山海骑行",
    );
    expect(out.map((o) => o.title)).toEqual(["山海骑行 (1/3)", "自定", "山海骑行 (3/3)"]);
  });
  it("没填分组标题时未命名条目保持无标题", () => {
    expect(titleBatchItems([{ url: "u1" }], "  ")).toEqual([{ url: "u1" }]);
  });
});

describe("generateBatchGroupKey", () => {
  it("只含服务端清洗后保留的字符，且不超过 100 字符", () => {
    const key = generateBatchGroupKey();
    expect(key).toMatch(/^batch:[A-Za-z0-9]+$/);
    expect(key.length).toBeLessThanOrEqual(100);
  });
  it("两次生成大概率不同（时间戳 + 随机后缀）", () => {
    expect(generateBatchGroupKey()).not.toBe(generateBatchGroupKey());
  });
});
