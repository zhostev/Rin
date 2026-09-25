import { useEffect, useState } from "react";
import { SharePosterModal, type SharePosterData } from "./share_poster";

type ShareButtonsProps = {
  title: string;
  url?: string;
  /** plain-text excerpt for the share poster */
  excerpt?: string;
  /** full markdown content for the long article image */
  content?: string;
  /** display date for the share poster, e.g. "2026-09-25" */
  date?: string;
  author?: string;
  siteName?: string;
};

/** Share UI copy is intentionally Chinese for b.s7ea.com. */
const COPY = {
  title: "分享",
  copyLink: "复制链接",
  copied: "已复制",
  native: "系统分享",
  twitter: "X",
  wechat: "微信",
} as const;

function canNativeShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function ShareButtons({ title, url, excerpt, content, date, author, siteName }: ShareButtonsProps) {
  const [copied, setCopied] = useState(false);
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [posterOpen, setPosterOpen] = useState(false);

  const shareUrl = url || (typeof window !== "undefined" ? window.location.href : "");

  useEffect(() => {
    setNativeAvailable(canNativeShare());
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function handleCopyLink() {
    const ok = await copyText(shareUrl);
    if (ok) {
      setCopied(true);
    }
  }

  async function handleNativeShare() {
    if (!canNativeShare()) return;
    try {
      await navigator.share({ title, url: shareUrl });
    } catch {
      // user cancelled or share failed — ignore
    }
  }

  async function handleWeChat() {
    // WeChat in-app browser can't receive shared links/images directly;
    // generate a poster image the user can long-press to save and share.
    setPosterOpen(true);
  }

  const posterData: SharePosterData = {
    title,
    excerpt: excerpt ?? "",
    content: content ?? "",
    url: shareUrl,
    date: date ?? "",
    author: author ?? "",
    siteName: siteName ?? "",
  };

  const twitterHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(shareUrl)}`;

  const buttonClass =
    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-secondary bg-button t-secondary text-sm transition hover:opacity-90";

  return (
    <div className="mt-4 flex flex-col gap-2" aria-label={COPY.title}>
      <div className="flex flex-row flex-wrap items-center gap-2">
        <span className="text-sm text-gray-400 shrink-0">{COPY.title}</span>
        <button
          type="button"
          className={buttonClass}
          onClick={handleCopyLink}
          aria-label={COPY.copyLink}
        >
          <i className={copied ? "ri-check-line" : "ri-link"} />
          <span>{copied ? COPY.copied : COPY.copyLink}</span>
        </button>
        {nativeAvailable && (
          <button
            type="button"
            className={buttonClass}
            onClick={handleNativeShare}
            aria-label={COPY.native}
          >
            <i className="ri-share-forward-line" />
            <span>{COPY.native}</span>
          </button>
        )}
        <a
          className={buttonClass}
          href={twitterHref}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={COPY.twitter}
        >
          <i className="ri-twitter-x-line" />
          <span>{COPY.twitter}</span>
        </a>
        <button
          type="button"
          className={buttonClass}
          onClick={handleWeChat}
          aria-label={COPY.wechat}
        >
          <i className="ri-wechat-line" />
          <span>{COPY.wechat}</span>
        </button>
      </div>
      {posterOpen && (
        <SharePosterModal data={posterData} onClose={() => setPosterOpen(false)} />
      )}
    </div>
  );
}
