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

/** Instagram 帖子/快拍视频页路径：/p/<code>、/reel/<code>、/reels/<code>、/tv/<code>（与服务端对齐）。 */
const INSTAGRAM_POST_PATH = /^\/(p|reel|reels|tv)\/([\w-]+)\/?$/;

/** 是否为 Instagram 帖子页 URL（与服务端 isInstagramPostUrl 对齐）。 */
export function isInstagramPostUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "instagram.com" && host !== "www.instagram.com") {
    return false;
  }
  return INSTAGRAM_POST_PATH.test(url.pathname);
}

/**
 * 按「整组导入」开关调整实际提交的 URL：
 * - 非 Instagram 帖子链接：原样返回；
 * - 开关开（默认）：原样返回，服务端整组导入；
 * - 开关关：帖子链接追加 img_index=1（只取第 1 个媒体）；链接里已有
 *   img_index 参数时尊重显式值，不覆盖。
 */
export function applyInstagramBatchPreference(raw: string, batchAll: boolean): string {
  const text = raw.trim();
  if (batchAll || !isInstagramPostUrl(text)) {
    return text;
  }
  // 已有 img_index 参数时尊重显式值；注意不能用 new URL().toString() 重序列化，
  // 它会把 ?stkn= 里 base64 的 = 转义成 %3D——这里只做字符串拼接，保持原链接不动。
  if (/[?&]img_index=/.test(text)) {
    return text;
  }
  return text + (text.includes("?") ? "&img_index=1" : "?img_index=1");
}
