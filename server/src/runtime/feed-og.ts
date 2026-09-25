import { and, eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { feeds } from "../db/schema";
import { extractImage, toAbsoluteUrl } from "../utils/image";
import { stripMarkdown } from "../utils/markdown";

const FEED_PATH_PATTERN = /^\/feed\/([^/]+)\/?$/;

/** UAs that need server-rendered Open Graph (SPA/react-helmet is invisible to them). */
const SOCIAL_CRAWLER_UA =
  /MicroMessenger|facebookexternalhit|Facebot|Twitterbot|Slackbot|LinkedInBot|Discordbot|WhatsApp|TelegramBot|SkypeUriPreview|Applebot|Googlebot|bingbot|Baiduspider|DuckDuckBot|Slurp|embedly|Quora Link Preview|outbrain|pinterest|vkShare|W3C_Validator|Bytespider|PetalBot/i;

export function matchFeedPath(pathname: string): string | null {
  const match = pathname.match(FEED_PATH_PATTERN);
  if (!match?.[1]) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function isSocialCrawler(userAgent: string | null | undefined): boolean {
  if (!userAgent) {
    return false;
  }
  return SOCIAL_CRAWLER_UA.test(userAgent);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncatePlainText(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export type FeedOgInput = {
  title: string;
  description: string;
  image?: string;
  url: string;
  siteName?: string;
};

export function buildFeedOgMetaTags(input: FeedOgInput): string {
  const title = escapeHtml(input.title);
  const description = escapeHtml(input.description);
  const url = escapeHtml(input.url);
  const siteName = escapeHtml(input.siteName || "Rin");
  const lines = [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:site_name" content="${siteName}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
  ];

  if (input.image) {
    const image = escapeHtml(input.image);
    lines.push(`<meta property="og:image" content="${image}" />`);
    lines.push(`<meta name="twitter:image" content="${image}" />`);
  }

  return `\n    ${lines.join("\n    ")}\n  `;
}

export function injectMetaIntoHtml(html: string, metaTags: string): string {
  if (html.includes("</head>")) {
    return html.replace("</head>", `${metaTags}</head>`);
  }
  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>${metaTags}`);
  }
  return `<!DOCTYPE html><html><head>${metaTags}</head><body>${html}</body></html>`;
}

function parseFeedId(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export async function loadPublishedFeedForOg(env: Env, slug: string) {
  if (!env.DB) {
    return null;
  }

  const db = drizzle(env.DB, { schema });
  const id = parseFeedId(slug);
  const where =
    id === null
      ? and(eq(feeds.alias, slug), eq(feeds.draft, 0))
      : and(or(eq(feeds.id, id), eq(feeds.alias, slug)), eq(feeds.draft, 0));

  const feed = await db.query.feeds.findFirst({ where });
  return feed ?? null;
}

export function buildFeedOgFromRecord(
  feed: {
    id: number;
    alias: string | null;
    title: string | null;
    summary: string;
    ai_summary: string;
    content: string;
  },
  env: Env,
  origin: string,
): FeedOgInput {
  const path = feed.alias ? `/feed/${feed.alias}` : `/feed/${feed.id}`;
  const url = `${origin.replace(/\/$/, "")}${path}`;
  const title = (feed.title || env.NAME || "Rin").trim() || "Rin";
  const descriptionSource =
    feed.summary?.trim() ||
    feed.ai_summary?.trim() ||
    stripMarkdown(feed.content || "") ||
    env.DESCRIPTION ||
    "";
  const description = truncatePlainText(descriptionSource || title);
  const image =
    toAbsoluteUrl(extractImage(feed.content || ""), origin) ||
    toAbsoluteUrl(env.AVATAR, origin);

  return {
    title,
    description,
    image,
    url,
    siteName: env.NAME || "Rin",
  };
}

/**
 * For social crawlers hitting /feed/:id|alias, inject Open Graph meta into the SPA shell.
 * MicroMessenger (WeChat) is included so share previews see og:image; the SPA scripts remain
 * so in-app opens still hydrate.
 */
export async function tryServeFeedOgForCrawler(
  request: Request,
  env: Env,
  serveSpaEntry: (request: Request, env: Env) => Promise<Response | null>,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }

  const userAgent = request.headers.get("user-agent");
  if (!isSocialCrawler(userAgent)) {
    return null;
  }

  const url = new URL(request.url);
  const slug = matchFeedPath(url.pathname);
  if (!slug) {
    return null;
  }

  try {
    const feed = await loadPublishedFeedForOg(env, slug);
    if (!feed) {
      return null;
    }

    const og = buildFeedOgFromRecord(feed, env, url.origin);
    const metaTags = buildFeedOgMetaTags(og);

    const spa = await serveSpaEntry(request, env);
    if (spa && spa.status === 200) {
      const html = await spa.text();
      const injected = injectMetaIntoHtml(html, metaTags);
      const headers = new Headers(spa.headers);
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set("Cache-Control", "public, max-age=120");
      headers.delete("Content-Length");
      return new Response(request.method === "HEAD" ? null : injected, {
        status: 200,
        headers,
      });
    }

    const fallback = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${metaTags}
  </head>
  <body>
    <p>${escapeHtml(og.title)}</p>
    <p>${escapeHtml(og.description)}</p>
  </body>
</html>`;
    return new Response(request.method === "HEAD" ? null : fallback, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=120",
      },
    });
  } catch (error) {
    console.error("feed OG render failed:", error);
    return null;
  }
}
