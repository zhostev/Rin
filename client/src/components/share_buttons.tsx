import { useEffect, useState } from "react";

type ShareButtonsProps = {
  title: string;
  url?: string;
};

/** Share UI copy is intentionally Chinese for b.s7ea.com. */
const COPY = {
  title: "分享",
  copyLink: "复制链接",
  copied: "已复制",
  native: "系统分享",
  twitter: "X",
  wechat: "微信",
  wechatTip: "链接已复制，请到微信粘贴分享",
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

export function ShareButtons({ title, url }: ShareButtonsProps) {
  const [copied, setCopied] = useState(false);
  const [wechatTip, setWechatTip] = useState(false);
  const [nativeAvailable, setNativeAvailable] = useState(false);

  const shareUrl = url || (typeof window !== "undefined" ? window.location.href : "");

  useEffect(() => {
    setNativeAvailable(canNativeShare());
  }, []);

  useEffect(() => {
    if (!copied && !wechatTip) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
      setWechatTip(false);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [copied, wechatTip]);

  async function handleCopyLink() {
    const ok = await copyText(shareUrl);
    if (ok) {
      setWechatTip(false);
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
    const ok = await copyText(shareUrl);
    if (ok) {
      setCopied(false);
      setWechatTip(true);
    }
  }

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
      {wechatTip && (
        <p className="text-xs text-gray-400" role="status">
          {COPY.wechatTip}
        </p>
      )}
    </div>
  );
}
