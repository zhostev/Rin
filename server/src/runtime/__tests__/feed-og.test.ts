import { describe, expect, it } from "bun:test";
import {
  buildFeedOgFromRecord,
  buildFeedOgMetaTags,
  escapeHtml,
  injectMetaIntoHtml,
  isSocialCrawler,
  matchFeedPath,
} from "../feed-og";

describe("matchFeedPath", () => {
  it("matches numeric and alias feed paths", () => {
    expect(matchFeedPath("/feed/5")).toBe("5");
    expect(matchFeedPath("/feed/seoul-skin-white-and-texture")).toBe(
      "seoul-skin-white-and-texture",
    );
    expect(matchFeedPath("/feed/5/")).toBe("5");
  });

  it("rejects non-feed paths", () => {
    expect(matchFeedPath("/")).toBeNull();
    expect(matchFeedPath("/feed")).toBeNull();
    expect(matchFeedPath("/feeds/5")).toBeNull();
    expect(matchFeedPath("/api/feed/5")).toBeNull();
  });
});

describe("isSocialCrawler", () => {
  it("detects WeChat and common social bots", () => {
    expect(isSocialCrawler("MicroMessenger/7.0.20")).toBe(true);
    expect(isSocialCrawler("facebookexternalhit/1.1")).toBe(true);
    expect(isSocialCrawler("Twitterbot/1.0")).toBe(true);
    expect(isSocialCrawler("Slackbot-LinkExpanding 1.0")).toBe(true);
  });

  it("ignores normal browsers", () => {
    expect(
      isSocialCrawler(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0",
      ),
    ).toBe(false);
    expect(isSocialCrawler(null)).toBe(false);
  });
});

describe("buildFeedOgMetaTags", () => {
  it("emits required Open Graph and Twitter tags", () => {
    const html = buildFeedOgMetaTags({
      title: 'Hello "World"',
      description: "A <desc>",
      image: "https://example.com/cover.jpg",
      url: "https://example.com/feed/5",
      siteName: "Rin",
    });

    expect(html).toContain('property="og:title" content="Hello &quot;World&quot;"');
    expect(html).toContain('property="og:description" content="A &lt;desc&gt;"');
    expect(html).toContain('property="og:image" content="https://example.com/cover.jpg"');
    expect(html).toContain('property="og:type" content="article"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('property="og:url" content="https://example.com/feed/5"');
  });
});

describe("injectMetaIntoHtml", () => {
  it("injects before closing head", () => {
    const result = injectMetaIntoHtml(
      "<html><head><meta charset='utf-8'></head><body></body></html>",
      '<meta property="og:title" content="t" />',
    );
    expect(result).toContain('<meta property="og:title" content="t" /></head>');
  });
});

describe("buildFeedOgFromRecord", () => {
  it("prefers summary and first markdown image", () => {
    const og = buildFeedOgFromRecord(
      {
        id: 5,
        alias: "seoul",
        title: "首尔街上的白",
        summary: "短摘要",
        ai_summary: "",
        content: "正文\n\n![x](https://b.s7ea.com/api/blob/images/a.jpg)\n\n更多",
      },
      { NAME: "弯曲的时间", AVATAR: "https://example.com/avatar.png" } as Env,
      "https://b.s7ea.com",
    );

    expect(og.title).toBe("首尔街上的白");
    expect(og.description).toBe("短摘要");
    expect(og.image).toBe("https://b.s7ea.com/api/blob/images/a.jpg");
    expect(og.url).toBe("https://b.s7ea.com/feed/seoul");
  });

  it("falls back to avatar when content has no image", () => {
    const og = buildFeedOgFromRecord(
      {
        id: 1,
        alias: null,
        title: "T",
        summary: "",
        ai_summary: "",
        content: "plain text only",
      },
      { AVATAR: "/avatar.png", NAME: "Rin" } as Env,
      "https://b.s7ea.com",
    );
    expect(og.image).toBe("https://b.s7ea.com/avatar.png");
    expect(og.url).toBe("https://b.s7ea.com/feed/1");
  });
});

describe("escapeHtml", () => {
  it("escapes reserved characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
