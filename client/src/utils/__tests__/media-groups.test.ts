import { describe, expect, it } from "bun:test";
import { groupAssets, groupTitle, isInstagramPostUrl, applyInstagramBatchPreference } from "../media-groups";
import type { MediaAsset } from "../../api/story";

const asset = (id: number, group_key?: string, title?: string): MediaAsset => ({
  id,
  kind: "image",
  url: `https://example.com/${id}.jpg`,
  ...(group_key !== undefined ? { group_key } : {}),
  ...(title !== undefined ? { title } : {}),
});

describe("groupAssets", () => {
  it("无 group_key 的资产各自成组", () => {
    const groups = groupAssets([asset(1), asset(2)]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.items).toHaveLength(1);
  });

  it("连续同组聚成一组", () => {
    const groups = groupAssets([
      asset(1, "instagram:abc"),
      asset(2, "instagram:abc"),
      asset(3, "instagram:abc"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((a) => a.id)).toEqual([1, 2, 3]);
  });

  it("被隔开的同组 key 不合并（避免翻页交错误并）", () => {
    const groups = groupAssets([
      asset(1, "instagram:abc"),
      asset(2),
      asset(3, "instagram:abc"),
    ]);
    expect(groups).toHaveLength(3);
  });

  it("空字符串 group_key 视为未分组", () => {
    const groups = groupAssets([asset(1, ""), asset(2, "")]);
    expect(groups).toHaveLength(2);
  });
});

describe("groupTitle", () => {
  it("去掉批量标题的 (N/M) 后缀", () => {
    expect(groupTitle(asset(1, "instagram:abc", "Kumamoto (1/3)"))).toBe("Kumamoto");
  });
  it("无标题时回退 #id", () => {
    expect(groupTitle(asset(42, "instagram:abc"))).toBe("#42");
  });
  it("普通标题原样返回", () => {
    expect(groupTitle(asset(1, undefined, "封面图"))).toBe("封面图");
  });
});

describe("isInstagramPostUrl", () => {
  it("识别 /p/ /reel/ 帖子链接", () => {
    expect(isInstagramPostUrl("https://www.instagram.com/p/DdRedA8gqdk/")).toBe(true);
    expect(isInstagramPostUrl("https://instagram.com/reel/C8xYz12/?stkn=abc")).toBe(true);
  });
  it("拒绝非帖子页与非法 URL", () => {
    expect(isInstagramPostUrl("https://www.instagram.com/explore/")).toBe(false);
    expect(isInstagramPostUrl("https://example.com/p/abc/")).toBe(false);
    expect(isInstagramPostUrl("not a url")).toBe(false);
  });
});

describe("applyInstagramBatchPreference", () => {
  const post = "https://www.instagram.com/p/DdgdB_uFEyY/?stkn=MTMwcmpwcHk2cDhpaA==";
  it("开关开：原样返回", () => {
    expect(applyInstagramBatchPreference(post, true)).toBe(post);
  });
  it("非帖子链接：原样返回", () => {
    const direct = "https://example.com/a.jpg";
    expect(applyInstagramBatchPreference(direct, false)).toBe(direct);
  });
  it("开关关：自带 ?stkn 参数的链接用 & 追加 img_index=1", () => {
    const out = applyInstagramBatchPreference(post, false);
    expect(out).toBe(`${post}&img_index=1`);
  });
  it("开关关：无参数的链接用 ? 追加 img_index=1", () => {
    expect(applyInstagramBatchPreference("https://www.instagram.com/p/abc123/", false)).toBe(
      "https://www.instagram.com/p/abc123/?img_index=1",
    );
  });
  it("链接里已有 img_index 时尊重显式值", () => {
    const withIndex = `${post}&img_index=7`;
    expect(applyInstagramBatchPreference(withIndex, false)).toBe(withIndex);
  });
});
