import type { MediaAsset } from "../api/story";

export interface AssetGroup {
  key: string;
  items: MediaAsset[];
}

/**
 * 同一次批量导入的图片按 group_key 聚成图片集。
 * 只合并连续相邻的同组资产，避免翻页交错时误并。
 */
export function groupAssets(assets: MediaAsset[]): AssetGroup[] {
  const groups: AssetGroup[] = [];
  for (const asset of assets) {
    const gk = asset.group_key?.trim() || "";
    const last = groups[groups.length - 1];
    if (gk && last && last.key === gk) {
      last.items.push(asset);
    } else {
      groups.push({ key: gk || `single:${asset.id}`, items: [asset] });
    }
  }
  return groups;
}

/** 去掉批量标题的 " (1/N)" 后缀，得到图片集标题。 */
export function groupTitle(first: MediaAsset): string {
  const title = (first.title || "").replace(/\s*\(\d+\/\d+\)$/, "");
  return title || `#${first.id}`;
}
