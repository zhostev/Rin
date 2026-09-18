import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type ShareButtonsProps = {
  title: string;
  url?: string;
};

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
  const { t } = useTranslation();
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
    <div className="mt-4 flex flex-col gap-2" aria-label={t("article.share.title")}>
      <div className="flex flex-row flex-wrap items-center gap-2">
        <span className="text-sm text-gray-400 shrink-0">{t("article.share.title")}</span>
        <button
          type="button"
          className={buttonClass}
          onClick={handleCopyLink}
          aria-label={t("article.share.copy_link")}
        >
          <i className={copied ? "ri-check-line" : "ri-link"} />
          <span>{copied ? t("article.share.copied") : t("article.share.copy_link")}</span>
        </button>
        {nativeAvailable && (
          <button
            type="button"
            className={buttonClass}
            onClick={handleNativeShare}
            aria-label={t("article.share.native")}
          >
            <i className="ri-share-forward-line" />
            <span>{t("article.share.native")}</span>
          </button>
        )}
        <a
          className={buttonClass}
          href={twitterHref}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("article.share.twitter")}
        >
          <i className="ri-twitter-x-line" />
          <span>{t("article.share.twitter")}</span>
        </a>
        <button
          type="button"
          className={buttonClass}
          onClick={handleWeChat}
          aria-label={t("article.share.wechat")}
        >
          <i className="ri-wechat-line" />
          <span>{t("article.share.wechat")}</span>
        </button>
      </div>
      {wechatTip && (
        <p className="text-xs text-gray-400" role="status">
          {t("article.share.wechat_tip")}
        </p>
      )}
    </div>
  );
}
