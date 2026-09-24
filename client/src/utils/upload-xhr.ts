// Generic browser file upload over raw XMLHttpRequest with progress events.
//
// Used for the Cloudflare Images direct-upload flow (PUT the raw file bytes
// to the one-time upload_url returned by POST /api/admin/media/images-upload).
// Unlike the JSON HttpClient this preserves XHR upload progress reporting.

export interface RawUploadOptions {
  method?: string;
  headers?: Record<string, string>;
  onProgress?: (loaded: number, total: number) => void;
}

export function uploadFileRaw(
  url: string,
  file: File,
  options: RawUploadOptions = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method ?? "PUT", url);
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      xhr.setRequestHeader(key, value);
    }
    if (options.onProgress) {
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          options.onProgress?.(event.loaded, event.total);
        }
      });
    }
    xhr.addEventListener("load", () => {
      resolve({ status: xhr.status, body: xhr.responseText });
    });
    xhr.addEventListener("error", () => reject(new Error("Upload network error")));
    xhr.addEventListener("abort", () => reject(new Error("Upload aborted")));
    xhr.send(file);
  });
}
