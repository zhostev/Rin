import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";

export type SharePosterData = {
  title: string;
  /** plain-text excerpt; falls back to content-derived text */
  excerpt: string;
  /** article url (absolute) encoded in the QR code */
  url: string;
  /** e.g. "2026-09-25" */
  date: string;
  author: string;
  siteName: string;
};

const COPY = {
  title: "微信分享",
  generating: "海报生成中…",
  saveImage: "保存图片",
  saved: "已保存",
  tip: "长按图片可保存，再分享到微信好友或朋友圈",
  close: "关闭",
  retry: "重新生成",
  failed: "海报生成失败，请重试",
} as const;

const W = 750;
const PAD = 48;
const SCALE = 2; // render at 2x for crispness

export function stripMarkdown(src: string): string {
  return (
    src
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/[*_~>|-]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length >= maxLines) break;
    } else {
      line = test;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines) {
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(last + "…").width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = last + "…";
  }
  return lines;
}

export async function renderPoster(data: SharePosterData): Promise<string> {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");

  const fontStack = `"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif`;
  const contentW = W - PAD * 2;

  // --- measure phase (1x) ---
  ctx.font = `700 40px ${fontStack}`;
  const titleLines = wrapText(ctx, data.title || "Untitled", contentW, 3);
  ctx.font = `400 25px ${fontStack}`;
  const excerptText = data.excerpt ? stripMarkdown(data.excerpt).slice(0, 160) : "";
  const excerptLines = excerptText ? wrapText(ctx, excerptText, contentW, 4) : [];

  const titleH = titleLines.length * 56;
  const excerptH = excerptLines.length * 38;
  const headerH = 64;
  const metaH = 40;
  const dividerH = 48;
  const qrSize = 168;
  const bottomH = Math.max(qrSize, 110) + 8;
  const footerH = 60;

  const H =
    PAD +
    headerH +
    24 +
    titleH +
    (excerptLines.length ? 20 + excerptH : 0) +
    16 +
    metaH +
    dividerH +
    bottomH +
    footerH +
    PAD;

  // --- draw phase (2x) ---
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  ctx.scale(SCALE, SCALE);

  // background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  // subtle top accent
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, "#6366f1");
  grad.addColorStop(1, "#a78bfa");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 8);

  let y = PAD;

  // header: site branding
  ctx.fillStyle = "#6366f1";
  ctx.font = `700 26px ${fontStack}`;
  ctx.fillText(data.siteName, PAD, y + 28);
  const brandW = ctx.measureText(data.siteName).width;
  ctx.fillStyle = "#9ca3af";
  ctx.font = `400 22px ${fontStack}`;
  try {
    const host = new URL(data.url).host;
    ctx.fillText(host, PAD + brandW + 16, y + 28);
  } catch {
    /* ignore */
  }
  y += headerH + 24;

  // title
  ctx.fillStyle = "#111827";
  ctx.font = `700 40px ${fontStack}`;
  for (const line of titleLines) {
    y += 56;
    ctx.fillText(line, PAD, y - 14);
  }

  // excerpt
  if (excerptLines.length) {
    y += 20;
    ctx.fillStyle = "#6b7280";
    ctx.font = `400 25px ${fontStack}`;
    for (const line of excerptLines) {
      y += 38;
      ctx.fillText(line, PAD, y - 10);
    }
  }

  // meta
  y += 16;
  ctx.fillStyle = "#9ca3af";
  ctx.font = `400 22px ${fontStack}`;
  ctx.fillText(`${data.date} · ${data.author}`, PAD, y + 28);
  y += metaH;

  // divider
  y += dividerH / 2;
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, y);
  ctx.lineTo(W - PAD, y);
  ctx.stroke();
  y += dividerH / 2;

  // QR code
  const qrDataUrl = await QRCode.toDataURL(data.url, {
    width: qrSize * SCALE,
    margin: 1,
    color: { dark: "#111827", light: "#ffffff" },
  });
  const qrImg = new Image();
  await new Promise<void>((resolve, reject) => {
    qrImg.onload = () => resolve();
    qrImg.onerror = () => reject(new Error("qr load failed"));
    qrImg.src = qrDataUrl;
  });
  const qrY = y;
  ctx.drawImage(qrImg, PAD, qrY, qrSize, qrSize);

  // QR side text
  const tx = PAD + qrSize + 32;
  ctx.fillStyle = "#111827";
  ctx.font = `600 28px ${fontStack}`;
  ctx.fillText("长按识别二维码", tx, qrY + 52);
  ctx.fillStyle = "#6b7280";
  ctx.font = `400 24px ${fontStack}`;
  ctx.fillText("阅读全文", tx, qrY + 92);
  y += bottomH;

  // footer
  ctx.fillStyle = "#d1d5db";
  ctx.font = `400 20px ${fontStack}`;
  ctx.textAlign = "center";
  ctx.fillText(`分享自 ${data.siteName}`, W / 2, H - PAD + 10);
  ctx.textAlign = "left";

  return canvas.toDataURL("image/png");
}

export function SharePosterModal({
  data,
  onClose,
}: {
  data: SharePosterData;
  onClose: () => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setImgUrl(null);
    setError(false);
    renderPoster(data)
      .then((url) => {
        if (!cancelled) setImgUrl(url);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

  useEffect(() => {
    if (!saved) return;
    timer.current = window.setTimeout(() => setSaved(false), 2000);
    return () => window.clearTimeout(timer.current);
  }, [saved]);

  // lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  function handleSave() {
    if (!imgUrl) return;
    const a = document.createElement("a");
    a.href = imgUrl;
    a.download = `share-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setSaved(true);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={COPY.title}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-base font-semibold text-gray-900">{COPY.title}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-gray-500 hover:bg-gray-100"
            aria-label={COPY.close}
          >
            <i className="ri-close-line text-xl" />
          </button>
        </div>
        <div className="flex max-h-[62vh] items-center justify-center overflow-auto bg-gray-100 px-4 py-4">
          {imgUrl ? (
            <img src={imgUrl} alt={COPY.title} className="w-full rounded-lg shadow" />
          ) : error ? (
            <div className="py-10 text-center">
              <p className="text-sm text-gray-500">{COPY.failed}</p>
              <button
                type="button"
                onClick={() => {
                  setError(false);
                  renderPoster(data)
                    .then(setImgUrl)
                    .catch(() => setError(true));
                }}
                className="mt-3 rounded-full bg-indigo-600 px-4 py-1.5 text-sm text-white"
              >
                {COPY.retry}
              </button>
            </div>
          ) : (
            <p className="py-10 text-sm text-gray-500">{COPY.generating}</p>
          )}
        </div>
        <div className="px-4 py-3">
          <p className="text-center text-xs text-gray-500">{COPY.tip}</p>
          <button
            type="button"
            onClick={handleSave}
            disabled={!imgUrl}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-full bg-indigo-600 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40"
          >
            <i className={saved ? "ri-check-line" : "ri-download-line"} />
            <span>{saved ? COPY.saved : COPY.saveImage}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
