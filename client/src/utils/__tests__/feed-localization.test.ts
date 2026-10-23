import { describe, expect, it } from "bun:test";
import {
  isEnglishLanguage,
  resolveLocalizedFeed,
  shouldRequestTranslation,
} from "../feed-localization";

const feed = { title: "中文标题", content: "中文正文", translationEnStatus: "completed" };
const done = { status: "completed" as const, titleEn: "English Title", contentEn: "English body" };

describe("isEnglishLanguage", () => {
  it("matches en and en-US, not other languages", () => {
    expect(isEnglishLanguage("en")).toBe(true);
    expect(isEnglishLanguage("en-US")).toBe(true);
    expect(isEnglishLanguage("zh-CN")).toBe(false);
    expect(isEnglishLanguage(undefined)).toBe(false);
  });
});

describe("resolveLocalizedFeed", () => {
  it("shows the English translation in English mode when completed", () => {
    const view = resolveLocalizedFeed(feed, done, "en");
    expect(view).toEqual({
      title: "English Title",
      content: "English body",
      translated: true,
      status: "completed",
    });
  });

  it("falls back to the original while translation is pending", () => {
    const view = resolveLocalizedFeed(feed, { status: "pending", titleEn: "", contentEn: "" }, "en");
    expect(view.translated).toBe(false);
    expect(view.content).toBe("中文正文");
    expect(view.status).toBe("pending");
  });

  it("never swaps content outside English mode", () => {
    const view = resolveLocalizedFeed(feed, done, "zh-CN");
    expect(view.translated).toBe(false);
    expect(view.title).toBe("中文标题");
  });

  it("falls back to the original title when the translated title is empty", () => {
    const view = resolveLocalizedFeed(feed, { status: "completed", titleEn: "", contentEn: "English body" }, "en");
    expect(view.title).toBe("中文标题");
    expect(view.content).toBe("English body");
  });
});

describe("shouldRequestTranslation", () => {
  it("requests only in English mode when not completed or in flight", () => {
    expect(shouldRequestTranslation("idle", "en")).toBe(true);
    expect(shouldRequestTranslation("failed", "en")).toBe(true);
    expect(shouldRequestTranslation("pending", "en")).toBe(false);
    expect(shouldRequestTranslation("processing", "en")).toBe(false);
    expect(shouldRequestTranslation("completed", "en")).toBe(false);
    expect(shouldRequestTranslation("idle", "zh-CN")).toBe(false);
  });
});
