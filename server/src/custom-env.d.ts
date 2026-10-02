import type { QueueTask } from "./queue";

declare global {
  interface Env {
    TASK_QUEUE?: Queue<QueueTask>;
    R2_BUCKET?: R2Bucket;
    /** Stage 4 · 站内问答向量索引（staging-only binding） */
    VECTORIZE?: VectorizeIndex;
    /** 站点公开访问地址（可选）。未设置时 sitemap/robots 回退到请求来源 origin */
    FRONTEND_URL?: string;
    // --- Stage 2 · 媒体栈（Cloudflare Stream / Images）---
    /** Cloudflare 账户 ID（Stream/Images API 路径必需） */
    CLOUDFLARE_ACCOUNT_ID?: string;
    /** 媒体栈 API Token（优先）；需具备 Stream 与 Images 权限 */
    CF_MEDIA_API_TOKEN?: string;
    /** 兼容：仅 Stream 权限的 Token（CF_MEDIA_API_TOKEN 未设置时回退） */
    CF_STREAM_TOKEN?: string;
    /** 兼容：仅 Images 权限的 Token（CF_MEDIA_API_TOKEN 未设置时回退） */
    CF_IMAGES_TOKEN?: string;
    /** Stream webhook 签名密钥（Dashboard > Stream > Webhooks 配置的 secret） */
    STREAM_WEBHOOK_SECRET?: string;
    // --- 站点元信息（feed-og 等处读取；未设置时回退默认值）---
    /** 站点名称 */
    NAME?: string;
    /** 站点描述 */
    DESCRIPTION?: string;
    /** 站点头像 URL（绝对或相对路径） */
    AVATAR?: string;
    // --- 访问分析 ---
    /** Analytics Engine 数据集 binding（文章浏览记录） */
    ANALYTICS?: AnalyticsEngineDataset;
    /** Cloudflare API Token（Analytics Engine SQL API 查询用；与媒体栈 token 独立） */
    CLOUDFLARE_API_TOKEN?: string;
    // --- 微信公众号草稿中转（ECS 固定 IP 服务）---
    /** 中转服务地址，如 http://1.2.3.4:18080（微信 token 接口校验 IP 白名单，Worker 不能直调） */
    WECHAT_RELAY_URL?: string;
    /** 中转服务鉴权密钥（与 ECS 的 RELAY_SECRET 相同） */
    WECHAT_RELAY_SECRET?: string;
    // --- Instagram 帖子解析（媒体库 from-url）---
    /** Apify API Token：用于把 Instagram 帖子链接解析成图片直链。
     *  帖子页 HTML 对机房 IP 会 429，抓取交给 Apify 的 actor。未配置时
     *  /api/admin/media/from-url 对 IG 链接返回 422 instagram_resolve_failed。 */
    APIFY_TOKEN?: string;
  }
}

export {};
