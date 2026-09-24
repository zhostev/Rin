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
  }
}

export {};
