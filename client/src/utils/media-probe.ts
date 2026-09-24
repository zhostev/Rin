// Probe duration / dimensions of a local media file before upload.
// Browsers only; failures resolve to an empty result — never throws.

export interface ProbedMedia {
  duration?: number; // seconds
  width?: number;
  height?: number;
  mime: string;
}

function probeWithElement(
  file: File,
  tag: "video" | "audio",
): Promise<{ duration?: number; width?: number; height?: number }> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const element = document.createElement(tag);
    element.preload = "metadata";
    const done = (result: { duration?: number; width?: number; height?: number }) => {
      URL.revokeObjectURL(objectUrl);
      resolve(result);
    };
    const timeout = window.setTimeout(() => done({}), 8000);
    element.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      const duration = Number.isFinite(element.duration) ? element.duration : undefined;
      const width =
        tag === "video" && (element as HTMLVideoElement).videoWidth
          ? (element as HTMLVideoElement).videoWidth
          : undefined;
      const height =
        tag === "video" && (element as HTMLVideoElement).videoHeight
          ? (element as HTMLVideoElement).videoHeight
          : undefined;
      done({ duration, width, height });
    };
    element.onerror = () => {
      window.clearTimeout(timeout);
      done({});
    };
    element.src = objectUrl;
  });
}

export async function probeMediaFile(file: File): Promise<ProbedMedia> {
  const mime = file.type || "";
  try {
    if (mime.startsWith("video/")) {
      const meta = await probeWithElement(file, "video");
      return { ...meta, mime };
    }
    if (mime.startsWith("audio/")) {
      const meta = await probeWithElement(file, "audio");
      return { duration: meta.duration, mime };
    }
  } catch {
    // fall through to the empty result
  }
  return { mime };
}
