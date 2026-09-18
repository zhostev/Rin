import type { QueueTask } from "./queue";

declare global {
  interface Env {
    TASK_QUEUE?: Queue<QueueTask>;
    R2_BUCKET?: R2Bucket;
    /** 站点公开访问地址（可选）。未设置时 sitemap/robots 回退到请求来源 origin */
    FRONTEND_URL?: string;
    /** Optional site identity vars written by deploy into wrangler [vars] */
    NAME?: string;
    DESCRIPTION?: string;
    AVATAR?: string;
    R2_BUCKET_NAME?: string;
  }
}

export {};
