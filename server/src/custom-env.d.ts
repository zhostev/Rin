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
    /**
     * Cloudflare VPC Service binding to the private ip2region HTTP service
     * (`GET /lookup?ip=<ipv4>`), used to resolve comment locations.
     * Configured in wrangler as `[[vpc_services]] binding = "IP2REGION"`.
     */
    IP2REGION?: Fetcher;
    /** Override the URL the IP2REGION binding is called with (hostname is ignored by VPC services) */
    IP2REGION_BASE_URL?: string;
    /** Public fallback URL for the ip2region service, used when no VPC binding exists */
    IP2REGION_URL?: string;
  }
}

export {};
