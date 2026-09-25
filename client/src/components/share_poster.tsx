import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type SharePosterData = {
  title: string;
  /** plain-text excerpt; falls back to content-derived text */
  excerpt: string;
  /** full markdown content for the long article image */
  content: string;
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
  shareImage: "分享图片",
  shared: "已分享",
  tip: "长按图片可保存，再分享到微信好友或朋友圈",
  tipShare: "将图片直接分享到微信好友或朋友圈",
  close: "关闭",
  retry: "重新生成",
  failed: "海报生成失败，请重试",
  tabPoster: "海报",
  tabArticle: "全文长图",
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

// ---------------------------------------------------------------------------
// Full-article long image
// ---------------------------------------------------------------------------

export type ArticleBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "image"; alt: string; src: string }
  | { type: "code"; text: string }
  | { type: "list"; items: string[] }
  | { type: "quote"; text: string };

function inlineText(src: string): string {
  return src
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .trim();
}

/** Split markdown into drawable blocks. Images must be on their own line. */
type InlineSegment =
  | { kind: "text"; text: string }
  | { kind: "image"; alt: string; src: string };

const INLINE_IMG_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Split a line into text / image segments, preserving order. */
function splitInlineImages(line: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let last = 0;
  INLINE_IMG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_IMG_RE.exec(line)) !== null) {
    if (m.index > last) segments.push({ kind: "text", text: line.slice(last, m.index) });
    segments.push({ kind: "image", alt: m[1], src: m[2] });
    last = m.index + m[0].length;
  }
  if (last < line.length) segments.push({ kind: "text", text: line.slice(last) });
  return segments;
}

export function parseArticleBlocks(markdown: string): ArticleBlock[] {
  const blocks: ArticleBlock[] = [];
  const lines = markdown.split("\n");
  const para: string[] = [];
  const listItems: string[] = [];
  const quoteLines: string[] = [];

  const flushPara = () => {
    if (para.length) {
      const text = inlineText(para.join(" "));
      if (text) blocks.push({ type: "paragraph", text });
      para.length = 0;
    }
  };
  const flushList = () => {
    if (listItems.length) {
      blocks.push({ type: "list", items: listItems.map(inlineText) });
      listItems.length = 0;
    }
  };
  const flushQuote = () => {
    if (quoteLines.length) {
      const text = inlineText(quoteLines.join(" "));
      if (text) blocks.push({ type: "quote", text });
      quoteLines.length = 0;
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      flushPara();
      flushList();
      flushQuote();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      if (code.length) blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }

    const h = /^(#{1,3})\s+(.*)/.exec(line);
    if (h) {
      flushPara();
      flushList();
      flushQuote();
      const text = inlineText(h[2]);
      if (text) blocks.push({ type: "heading", level: h[1].length, text });
      i++;
      continue;
    }

    const img = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(line.trim());
    if (img) {
      flushPara();
      flushList();
      flushQuote();
      blocks.push({ type: "image", alt: img[1], src: img[2] });
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushPara();
      flushList();
      quoteLines.push(line.replace(/^>\s?/, ""));
      i++;
      continue;
    }

    const li = /^[-*+]\s+(.*)/.exec(line);
    if (li) {
      flushPara();
      flushQuote();
      listItems.push(li[1]);
      i++;
      continue;
    }

    if (!line.trim()) {
      flushPara();
      flushList();
      flushQuote();
      i++;
      continue;
    }

    flushList();
    flushQuote();
    // Inline images (e.g. text ![](url) inside a paragraph) must become their
    // own image blocks — otherwise inlineText() swallows them silently.
    const segments = splitInlineImages(line.trim());
    if (segments.length > 1 || (segments.length === 1 && segments[0].kind === "image")) {
      flushPara();
      for (const s of segments) {
        if (s.kind === "image") {
          blocks.push({ type: "image", alt: s.alt, src: s.src });
        } else {
          const text = inlineText(s.text);
          if (text) blocks.push({ type: "paragraph", text });
        }
      }
    } else {
      para.push(line.trim());
    }
    i++;
  }
  flushPara();
  flushList();
  flushQuote();
  return blocks;
}

function loadImg(src: string, timeoutMs: number, crossOrigin: boolean): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), timeoutMs);
    const img = new Image();
    img.onload = () => {
      window.clearTimeout(timer);
      resolve(img.naturalWidth > 0 ? img : null);
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };
    if (crossOrigin) img.crossOrigin = "anonymous";
    img.src = src;
  });
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Load an article image for canvas drawing.
 *
 * Same-origin images are fetched as a blob and decoded from an object URL
 * instead of `<img crossorigin="anonymous">`: iOS Safari fails the CORS
 * revalidation when the same URL is already in cache from a non-CORS page
 * load, so article images silently failed to load there. Same-origin pixels
 * never taint the canvas, so no CORS dance is needed at all.
 */
function loadArticleImage(src: string, timeoutMs = 15000): Promise<HTMLImageElement | null> {
  return (async () => {
    try {
      const url = new URL(src, window.location.href);
      if (url.origin === window.location.origin) {
        const res = await fetchWithTimeout(url.href, timeoutMs);
        if (!res.ok) return null;
        const blob = await res.blob();
        if (!blob.type.startsWith("image/")) return null;
        const objUrl = URL.createObjectURL(blob);
        try {
          return await loadImg(objUrl, timeoutMs, false);
        } finally {
          // The bitmap is decoded by now; revoking only prevents new loads.
          URL.revokeObjectURL(objUrl);
        }
      }
      // Cross-origin: classic CORS image load; skipped (placeholder) on failure.
      return await loadImg(src, timeoutMs, true);
    } catch {
      return null;
    }
  })();
}

const ARTICLE_FONT = `"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif`;
const ARTICLE_MONO = `"SFMono-Regular",Menlo,Consolas,monospace`;

function headingFont(level: number): { size: number; weight: number } {
  if (level === 1) return { size: 36, weight: 700 };
  if (level === 2) return { size: 32, weight: 700 };
  return { size: 28, weight: 700 };
}

/** Render the full article (text + images) as one long image. */
export async function renderArticleImage(data: SharePosterData): Promise<string> {
  const blocks = parseArticleBlocks(data.content || "");
  const contentW = W - PAD * 2;

  // Preload images so we know their dimensions before measuring.
  const loaded = new Map<number, HTMLImageElement | null>();
  await Promise.all(
    blocks.map(async (b, idx) => {
      if (b.type === "image") loaded.set(idx, await loadArticleImage(b.src));
    }),
  );

  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) throw new Error("no 2d context");

  type Measured =
    | { kind: "heading"; block: Extract<ArticleBlock, { type: "heading" }>; lines: string[]; h: number }
    | { kind: "paragraph"; block: Extract<ArticleBlock, { type: "paragraph" }>; lines: string[]; h: number }
    | { kind: "image"; block: Extract<ArticleBlock, { type: "image" }>; img: HTMLImageElement | null; h: number }
    | { kind: "code"; block: Extract<ArticleBlock, { type: "code" }>; lines: string[]; h: number }
    | { kind: "list"; block: Extract<ArticleBlock, { type: "list" }>; items: string[][]; h: number }
    | { kind: "quote"; block: Extract<ArticleBlock, { type: "quote" }>; lines: string[]; h: number };

  const measured: Measured[] = blocks.map((b, idx) => {
    switch (b.type) {
      case "heading": {
        const { size, weight } = headingFont(b.level);
        measure.font = `${weight} ${size}px ${ARTICLE_FONT}`;
        const lines = wrapText(measure, b.text, contentW, 10);
        return { kind: "heading", block: b, lines, h: 18 + lines.length * (size + 14) + 10 };
      }
      case "paragraph": {
        measure.font = `400 26px ${ARTICLE_FONT}`;
        const lines = wrapText(measure, b.text, contentW, Number.MAX_SAFE_INTEGER);
        return { kind: "paragraph", block: b, lines, h: lines.length * 42 + 22 };
      }
      case "image": {
        const img = loaded.get(idx) ?? null;
        let h = 120;
        if (img && img.naturalWidth > 0) {
          h = Math.min(900, (contentW * img.naturalHeight) / img.naturalWidth);
        }
        return { kind: "image", block: b, img, h: h + 28 };
      }
      case "code": {
        measure.font = `400 22px ${ARTICLE_MONO}`;
        const raw = b.text.split("\n");
        const lines: string[] = [];
        for (const rl of raw) {
          const wrapped = wrapText(measure, rl || " ", contentW - 56, Number.MAX_SAFE_INTEGER);
          lines.push(...(wrapped.length ? wrapped : [" "]));
        }
        return { kind: "code", block: b, lines, h: lines.length * 34 + 44 };
      }
      case "list": {
        measure.font = `400 26px ${ARTICLE_FONT}`;
        const items = b.items.map((it) =>
          wrapText(measure, it, contentW - 36, Number.MAX_SAFE_INTEGER),
        );
        const h = items.reduce((s, ls) => s + ls.length * 42, 0) + 22;
        return { kind: "list", block: b, items, h };
      }
      case "quote": {
        measure.font = `400 25px ${ARTICLE_FONT}`;
        const lines = wrapText(measure, b.text, contentW - 32, Number.MAX_SAFE_INTEGER);
        return { kind: "quote", block: b, lines, h: lines.length * 40 + 22 };
      }
    }
  });

  const headerH = 64;
  const titleH = (() => {
    measure.font = `700 40px ${ARTICLE_FONT}`;
    return wrapText(measure, data.title || "Untitled", contentW, 3).length * 56;
  })();
  const metaH = 40;
  const dividerH = 48;
  const qrSize = 168;
  const bottomH = Math.max(qrSize, 110) + 8;
  const footerH = 60;
  const bodyH = measured.reduce((s, m) => s + m.h, 0);

  const H =
    PAD + headerH + 24 + titleH + 16 + metaH + dividerH + bodyH + dividerH + bottomH + footerH + PAD;

  const canvas = document.createElement("canvas");
  canvas.width = W * SCALE;
  canvas.height = Math.round(H * SCALE);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.scale(SCALE, SCALE);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, "#6366f1");
  grad.addColorStop(1, "#a78bfa");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 8);

  let y = PAD;

  // header
  ctx.fillStyle = "#6366f1";
  ctx.font = `700 26px ${ARTICLE_FONT}`;
  ctx.fillText(data.siteName, PAD, y + 28);
  const brandW = ctx.measureText(data.siteName).width;
  ctx.fillStyle = "#9ca3af";
  ctx.font = `400 22px ${ARTICLE_FONT}`;
  try {
    ctx.fillText(new URL(data.url).host, PAD + brandW + 16, y + 28);
  } catch {
    /* ignore */
  }
  y += headerH + 24;

  // title
  ctx.fillStyle = "#111827";
  ctx.font = `700 40px ${ARTICLE_FONT}`;
  for (const line of wrapText(ctx, data.title || "Untitled", contentW, 3)) {
    y += 56;
    ctx.fillText(line, PAD, y - 14);
  }

  // meta
  y += 16;
  ctx.fillStyle = "#9ca3af";
  ctx.font = `400 22px ${ARTICLE_FONT}`;
  const meta = [data.date, data.author].filter(Boolean).join(" · ");
  if (meta) ctx.fillText(meta, PAD, y + 28);
  y += metaH;

  const drawDivider = () => {
    y += dividerH / 2;
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, y);
    ctx.lineTo(W - PAD, y);
    ctx.stroke();
    y += dividerH / 2;
  };
  drawDivider();

  // body blocks
  for (const m of measured) {
    switch (m.kind) {
      case "heading": {
        const { size, weight } = headingFont(m.block.level);
        ctx.fillStyle = "#111827";
        ctx.font = `${weight} ${size}px ${ARTICLE_FONT}`;
        y += 18;
        for (const line of m.lines) {
          y += size + 14;
          ctx.fillText(line, PAD, y - 8);
        }
        y += 10;
        break;
      }
      case "paragraph": {
        ctx.fillStyle = "#374151";
        ctx.font = `400 26px ${ARTICLE_FONT}`;
        for (const line of m.lines) {
          y += 42;
          ctx.fillText(line, PAD, y - 12);
        }
        y += 22;
        break;
      }
      case "image": {
        const boxH = m.h - 28;
        if (m.img && m.img.naturalWidth > 0) {
          const dw = contentW;
          const dh = Math.min(900, (contentW * m.img.naturalHeight) / m.img.naturalWidth);
          const dx = PAD;
          const dy = y;
          ctx.save();
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") ctx.roundRect(dx, dy, dw, dh, 12);
          else ctx.rect(dx, dy, dw, dh);
          ctx.clip();
          ctx.drawImage(m.img, dx, dy, dw, dh);
          ctx.restore();
        } else {
          ctx.fillStyle = "#f3f4f6";
          ctx.fillRect(PAD, y, contentW, boxH);
          ctx.fillStyle = "#9ca3af";
          ctx.font = `400 22px ${ARTICLE_FONT}`;
          ctx.textAlign = "center";
          ctx.fillText(m.block.alt || "图片加载失败", W / 2, y + boxH / 2 + 8);
          ctx.textAlign = "left";
        }
        y += m.h;
        break;
      }
      case "code": {
        const boxH = m.h;
        ctx.fillStyle = "#f3f4f6";
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") ctx.roundRect(PAD, y, contentW, boxH, 8);
        else ctx.rect(PAD, y, contentW, boxH);
        ctx.fill();
        ctx.fillStyle = "#1f2937";
        ctx.font = `400 22px ${ARTICLE_MONO}`;
        let cy = y + 22;
        for (const line of m.lines) {
          cy += 34;
          ctx.fillText(line, PAD + 28, cy - 10);
        }
        y += boxH + 22;
        break;
      }
      case "list": {
        ctx.fillStyle = "#374151";
        ctx.font = `400 26px ${ARTICLE_FONT}`;
        for (const lines of m.items) {
          for (let li = 0; li < lines.length; li++) {
            y += 42;
            ctx.fillText(li === 0 ? "•" : " ", PAD, y - 12);
            ctx.fillText(lines[li], PAD + 36, y - 12);
          }
        }
        y += 22;
        break;
      }
      case "quote": {
        ctx.fillStyle = "#d1d5db";
        ctx.fillRect(PAD, y, 4, m.h - 22);
        ctx.fillStyle = "#6b7280";
        ctx.font = `400 25px ${ARTICLE_FONT}`;
        for (const line of m.lines) {
          y += 40;
          ctx.fillText(line, PAD + 32, y - 11);
        }
        y += 22;
        break;
      }
    }
  }

  drawDivider();

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
  const tx = PAD + qrSize + 32;
  ctx.fillStyle = "#111827";
  ctx.font = `600 28px ${ARTICLE_FONT}`;
  ctx.fillText("长按识别二维码", tx, qrY + 52);
  ctx.fillStyle = "#6b7280";
  ctx.font = `400 24px ${ARTICLE_FONT}`;
  ctx.fillText("阅读全文", tx, qrY + 92);
  y += bottomH;

  // footer
  ctx.fillStyle = "#d1d5db";
  ctx.font = `400 20px ${ARTICLE_FONT}`;
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
  const [status, setStatus] = useState<"idle" | "saved" | "shared">("idle");
  const [tab, setTab] = useState<"poster" | "article">("poster");
  const [canNativeFileShare, setCanNativeFileShare] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setImgUrl(null);
    setError(false);
    const render = tab === "poster" ? renderPoster : renderArticleImage;
    render(data)
      .then((url) => {
        if (!cancelled) setImgUrl(url);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [data, tab]);

  useEffect(() => {
    if (status === "idle") return;
    timer.current = window.setTimeout(() => setStatus("idle"), 2000);
    return () => window.clearTimeout(timer.current);
  }, [status]);

  // iOS Safari (15+) can share image files via the native share sheet, which
  // lets the user send the poster straight to WeChat. The classic
  // `<a download>` trick does NOT work on iOS: the file lands in the Files
  // app's downloads instead of Photos, looking like "nothing happened".
  useEffect(() => {
    try {
      const probe = new File([""], "probe.png", { type: "image/png" });
      setCanNativeFileShare(
        typeof navigator.canShare === "function" && navigator.canShare({ files: [probe] }),
      );
    } catch {
      setCanNativeFileShare(false);
    }
  }, []);

  // NOTE: do NOT lock scroll via `document.body.style.overflow = "hidden"`.
  // On iOS Safari that breaks `position: fixed` (it lays out against the full
  // document height), pushing the centered card off-screen. The inner image
  // area keeps `touch-action: pan-y` + `overscroll-contain` for scrolling.

  async function handleSave() {
    if (!imgUrl) return;
    try {
      const blob = await (await fetch(imgUrl)).blob();
      const filename = `share-${tab}-${Date.now()}.png`;
      if (canNativeFileShare) {
        const file = new File([blob], filename, { type: "image/png" });
        await navigator.share({ files: [file], title: data.title });
        setStatus("shared");
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.setTimeout(() => URL.revokeObjectURL(url), 5000);
        setStatus("saved");
      }
    } catch {
      // user cancelled the share sheet or the share failed — stay silent
    }
  }

  function handleRetry() {
    setError(false);
    const render = tab === "poster" ? renderPoster : renderArticleImage;
    render(data)
      .then(setImgUrl)
      .catch(() => setError(true));
  }

  return createPortal(
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
        <div className="flex gap-1 px-4 pb-3">
          {(
            [
              ["poster", COPY.tabPoster],
              ["article", COPY.tabArticle],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`flex-1 rounded-full py-1.5 text-sm transition ${
                tab === key
                  ? "bg-indigo-600 font-medium text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex max-h-[62vh] touch-pan-y items-center justify-center overflow-auto overscroll-contain bg-gray-100 px-4 py-4">
          {imgUrl ? (
            <img src={imgUrl} alt={COPY.title} className="w-full rounded-lg shadow" />
          ) : error ? (
            <div className="py-10 text-center">
              <p className="text-sm text-gray-500">{COPY.failed}</p>
              <button
                type="button"
                onClick={handleRetry}
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
          <p className="text-center text-xs text-gray-500">
            {canNativeFileShare ? COPY.tipShare : COPY.tip}
          </p>
          <button
            type="button"
            onClick={handleSave}
            disabled={!imgUrl}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-full bg-indigo-600 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40"
          >
            <i
              className={
                status !== "idle"
                  ? "ri-check-line"
                  : canNativeFileShare
                    ? "ri-share-forward-line"
                    : "ri-download-line"
              }
            />
            <span>
              {status === "shared"
                ? COPY.shared
                : status === "saved"
                  ? COPY.saved
                  : canNativeFileShare
                    ? COPY.shareImage
                    : COPY.saveImage}
            </span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
