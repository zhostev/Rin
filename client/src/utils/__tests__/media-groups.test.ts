import { describe, expect, it } from "bun:test";
import { groupAssets, groupTitle } from "../media-groups";
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
