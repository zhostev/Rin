import type { FeedTranslationResponse } from "@rin/api";

export type TranslationStatus = "idle" | "pending" | "processing" | "completed" | "failed";

/** 站点语言是否为英文（i18next 的 en / en-US 等都算）。 */
export function isEnglishLanguage(language: string | undefined | null): boolean {
  return typeof language === "string" && language.toLowerCase().startsWith("en");
}

export interface LocalizedFeedView {
  title: string;
  content: string;
  /** true = 当前展示的是英文译文（而非中文原文）。 */
  translated: boolean;
  status: TranslationStatus;
}

/**
 * Pure: 英文模式下优先展示译文；译文未完成时回退原文（页面同时给出翻译状态提示）。
 * 非英文模式永远展示原文。
 */
export function resolveLocalizedFeed(
  feed: { title: string | null; content: string; translationEnStatus?: string },
  translation: Pick<FeedTranslationResponse, "status" | "titleEn" | "contentEn"> | null,
  language: string | undefined | null,
): LocalizedFeedView {
  const original: LocalizedFeedView = {
    title: feed.title ?? "",
    content: feed.content,
    translated: false,
    status: (translation?.status ?? feed.translationEnStatus ?? "idle") as TranslationStatus,
  };
  if (!isEnglishLanguage(language)) {
    return original;
  }
  if (translation?.status === "completed" && translation.contentEn) {
    return {
      title: translation.titleEn || original.title,
      content: translation.contentEn,
      translated: true,
      status: "completed",
    };
  }
  return original;
}

/** Pure: 是否需要按需触发翻译（英文模式、未完成、不在途时才触发，避免重复入队）。 */
export function shouldRequestTranslation(
  status: TranslationStatus | string | undefined,
  language: string | undefined | null,
): boolean {
  if (!isEnglishLanguage(language)) return false;
  return status !== "completed" && status !== "pending" && status !== "processing";
}
