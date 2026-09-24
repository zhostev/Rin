// Browser upload of a video file to a Cloudflare Stream direct-upload URL.
//
// Cloudflare Stream supports the tus resumable protocol on the one-time
// upload_url returned by POST /api/admin/media/stream-upload:
// the upload_url is passed straight to tus-js-client as the endpoint,
// chunks must be >= 5 MB (50 MB recommended).

import { Upload } from "tus-js-client";

export interface StreamUploadCallbacks {
  onProgress?: (bytesUploaded: number, bytesTotal: number) => void;
  onSuccess?: (uploadUrl: string) => void;
  onError?: (error: Error) => void;
}

export interface StreamUploadHandle {
  /** Abort the in-flight upload (safe to call after completion). */
  abort: () => void;
  /** Resolves with the tus upload URL when the upload completes. */
  done: Promise<string>;
}

/** Cloudflare-recommended chunk size for Stream uploads (50 MB). */
export const STREAM_CHUNK_SIZE = 50 * 1024 * 1024;

const RETRY_DELAYS = [0, 3000, 5000, 10000, 20000];

export function startStreamUpload(
  file: File,
  uploadURL: string,
  callbacks: StreamUploadCallbacks = {},
): StreamUploadHandle {
  let resolveDone: (url: string) => void = () => undefined;
  let rejectDone: (error: Error) => void = () => undefined;
  const done = new Promise<string>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const upload = new Upload(file, {
    endpoint: uploadURL,
    chunkSize: STREAM_CHUNK_SIZE,
    retryDelays: RETRY_DELAYS,
    metadata: {
      name: file.name,
      filetype: file.type,
    },
    onProgress: (bytesUploaded, bytesTotal) => {
      callbacks.onProgress?.(bytesUploaded, bytesTotal);
    },
    onSuccess: () => {
      const url = upload.url ?? uploadURL;
      callbacks.onSuccess?.(url);
      resolveDone(url);
    },
    onError: (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      callbacks.onError?.(err);
      rejectDone(err);
    },
  });

  upload.start();

  return {
    abort: () => {
      upload.abort().catch(() => {
        // abort after completion rejects; not an error worth surfacing
      });
      rejectDone(new Error("Upload aborted"));
    },
    done,
  };
}
