import type { QueueTask } from "./queue";

declare global {
  interface StreamDirectUploadResult {
    uploadURL: string;
    id: string;
  }

  interface StreamVideoDetails {
    id: string;
    readyToStream: boolean;
    size?: number;
    status?: { state?: string };
  }

  interface StreamVideoHandle {
    details(): Promise<StreamVideoDetails>;
    delete(): Promise<void>;
    generateToken(): Promise<string>;
  }

  interface StreamBinding {
    createDirectUpload(options: {
      maxDurationSeconds: number;
      creator?: string;
      meta?: Record<string, string>;
      allowedOrigins?: string[];
      requireSignedURLs?: boolean;
    }): Promise<StreamDirectUploadResult>;
    video(id: string): StreamVideoHandle;
  }

  interface Env {
    TASK_QUEUE?: Queue<QueueTask>;
    R2_BUCKET?: R2Bucket;
    STREAM?: StreamBinding;
    STREAM_PUBLIC_HOST?: string;
    STREAM_WEBHOOK_SECRET?: string;
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
