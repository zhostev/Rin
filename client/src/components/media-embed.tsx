import type { MediaType } from "@rin/api";
import { useTranslation } from "react-i18next";

type MediaEmbedProps = {
  id?: string;
  type: MediaType;
  provider?: "r2" | "stream";
  title?: string;
  className?: string;
};

function playbackUrl(id: string) {
  return `/api/media/${encodeURIComponent(id)}/playback`;
}

export function MediaEmbed({ id, type, provider = "r2", title, className }: MediaEmbedProps) {
  const { t } = useTranslation();

  if (!id) {
    return (
      <div className="my-4 rounded-2xl border border-dashed border-black/10 bg-secondary px-4 py-5 text-sm t-secondary dark:border-white/10">
        {t("media.unavailable")}
      </div>
    );
  }

  const label = title || t(type === "audio" ? "media.audio" : "media.video");
  const source = playbackUrl(id);

  return (
    <figure className={`my-5 overflow-hidden rounded-2xl border border-black/5 bg-w shadow-sm dark:border-white/10 ${className || ""}`}>
      {provider === "stream" ? (
        <iframe
          className="block aspect-video w-full bg-black"
          src={source}
          title={label}
          loading="lazy"
          allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      ) : type === "video" ? (
        <video
          className="block aspect-video w-full bg-black object-contain"
          controls
          preload="metadata"
          playsInline
          src={source}
          aria-label={label}
        />
      ) : (
        <div className="flex items-center gap-4 px-4 py-4 sm:px-5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-theme/10 text-theme">
            <i className="ri-volume-up-line ri-lg" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <figcaption className="mb-2 truncate text-sm font-medium t-primary">{label}</figcaption>
            <audio className="h-9 w-full" controls preload="metadata" src={source} aria-label={label} />
          </div>
        </div>
      )}
      {title && type === "video" ? <figcaption className="px-4 py-3 text-sm t-secondary sm:px-5">{title}</figcaption> : null}
    </figure>
  );
}

export function buildMediaMarkup(type: MediaType, id: string, title?: string, provider?: "r2" | "stream") {
  const safeTitle = title?.replace(/["<>]/g, "");
  const titleAttribute = safeTitle ? ` title="${safeTitle}"` : "";
  const providerAttribute = provider && provider !== "r2" ? ` data-rin-media-provider="${provider}"` : "";
  return `<${type} data-rin-media-id="${id}"${providerAttribute}${titleAttribute} controls></${type}>\n`;
}
