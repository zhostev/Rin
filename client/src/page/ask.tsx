// Stage 4 public "AI 问本站" page: /ask.
//
// Asks the site's AI over the local corpus. Answers render as markdown with
// clickable citations (story paragraph or media timecode), a clear
// "本站没有覆盖" state for coverage:'none', and a "最后核验日期" line for
// finance/policy answers (when the backend returns verifiedAt).
// Related content comes from GET /api/ask/recommend?storyId= — the contract
// takes a numeric storyId, but ask citations only carry storySlug, so the
// slug is passed and alignment is left to the backend lane (see final report).

import { Spinner } from "@rin/ui";
import { useCallback, useEffect, useState } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import { Link, useSearch } from "wouter";
import type { AskCitation, AskMode, AskResponse, RecommendItem } from "../api/ai-studio";
import { client } from "../app/runtime";
import { AskBox } from "../components/ask-box";
import { Markdown } from "../components/markdown";
import { useSiteConfig } from "../hooks/useSiteConfig";
import { siteName } from "../utils/constants";

const MOCK_ANSWER: AskResponse = {
  answer:
    "这是**演示回答**（后端 /api/ask 尚未联调）。\n\n本站内容包支持文本、视频、音频块组织；引用会直接跳到对应段落或媒体时间码。",
  citations: [
    {
      storySlug: "demo-story",
      title: "演示内容包",
      blockId: "b1",
      text: "内容包支持文本、视频、音频块。",
      url: "/story/demo-story",
    },
  ],
  coverage: "partial",
  verifiedAt: "2026-09-24",
};

function CitationCard({ citation, index }: { citation: AskCitation; index: number }) {
  const { t } = useTranslation();
  const href = citation.url ?? `/story/${citation.storySlug}`;
  const internal = href.startsWith("/");
  const inner = (
    <>
      <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-theme/10 text-xs font-bold text-theme">
        {index + 1}
      </span>
      <span className="font-medium t-primary group-hover:text-theme">{citation.title}</span>
      {citation.text ? (
        <span className="mt-1 block text-sm leading-6 t-secondary line-clamp-2">{citation.text}</span>
      ) : null}
      <span className="mt-1 block truncate font-mono text-xs text-neutral-400">{href}</span>
    </>
  );
  return internal ? (
    <Link href={href} className="group block rounded-2xl bg-w p-4 hover:shadow">
      {inner}
    </Link>
  ) : (
    <a href={href} target="_blank" rel="noreferrer" className="group block rounded-2xl bg-w p-4 hover:shadow">
      {inner}
      <span className="sr-only">{t("ask.external_link")}</span>
    </a>
  );
}

function RelatedList({ items, loading }: { items: RecommendItem[]; loading: boolean }) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-neutral-500">
        <Spinner label={t("ask.related_loading")} />
        <span>{t("ask.related_loading")}</span>
      </div>
    );
  }
  if (items.length === 0) return null;
  return (
    <section aria-label={t("ask.related")} className="flex flex-col gap-3">
      <h2 className="text-lg font-bold t-primary">{t("ask.related")}</h2>
      {items.map((item) => (
        <Link
          key={item.storySlug}
          href={`/story/${item.storySlug}`}
          className="block rounded-2xl bg-w p-4 hover:shadow"
        >
          <p className="font-medium t-primary hover:text-theme">{item.title}</p>
          <p className="mt-1 text-sm leading-6 t-secondary">{item.reason}</p>
        </Link>
      ))}
    </section>
  );
}

export function AskPage() {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();
  const search = useSearch();
  const initialQuestion = new URLSearchParams(search).get("q") ?? "";

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [response, setResponse] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mockMode, setMockMode] = useState(false);
  const [related, setRelated] = useState<RecommendItem[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);

  const loadRelated = useCallback(async (citations: AskCitation[]) => {
    const first = citations[0];
    if (!first) {
      setRelated([]);
      return;
    }
    setRelatedLoading(true);
    try {
      // Contract deviation: /api/ask/recommend takes storyId, citations carry
      // storySlug — pass the slug; backend lane to align.
      const { data, error: recommendError } = await client.ask.recommend(first.storySlug);
      if (!recommendError && data && Array.isArray(data.items)) {
        setRelated(data.items);
      } else {
        setRelated([]);
      }
    } catch {
      setRelated([]);
    } finally {
      setRelatedLoading(false);
    }
  }, []);

  async function handleAsk(nextQuestion: string, nextMode: AskMode) {
    setQuestion(nextQuestion);
    setAsking(true);
    setError(null);
    setResponse(null);
    setRelated([]);
    try {
      const { data, error: askError } = await client.ask.ask(nextQuestion, nextMode);
      if (askError || !data) {
        setMockMode(true);
        setResponse(MOCK_ANSWER);
        setRelated([]);
      } else {
        setMockMode(false);
        setResponse(data);
        void loadRelated(data.citations ?? []);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setAsking(false);
    }
  }

  // Support /ask?q=... entry links (e.g. from the search page).
  const autoAsked = useState(() => initialQuestion.trim().length > 0)[0];
  useEffect(() => {
    if (autoAsked) {
      void handleAsk(initialQuestion.trim(), "quick");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const citations = response?.citations ?? [];

  return (
    <>
      <Helmet>
        <title>{`${t("ask.title")} - ${siteConfig.name}`}</title>
        <meta property="og:site_name" content={siteName} />
        <meta property="og:title" content={t("ask.title")} />
        <meta property="og:type" content="website" />
      </Helmet>

      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold t-primary md:text-3xl">{t("ask.title")}</h1>
          <p className="mt-2 text-sm leading-6 text-neutral-500 dark:text-neutral-400">
            {t("ask.subtitle")}
          </p>
        </div>

        <AskBox initialQuestion={initialQuestion} asking={asking} onSubmit={handleAsk} />

        {asking ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-neutral-500">
            <Spinner label={t("ask.asking")} />
            <span>{t("ask.asking")}</span>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-2xl border border-rose-200/80 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
            {error}
          </div>
        ) : null}

        {!asking && response ? (
          <div className="flex flex-col gap-6">
            {mockMode ? (
              <p className="text-center text-xs text-amber-700 dark:text-amber-300">
                {t("ai_studio.demo_badge")}
              </p>
            ) : null}

            {response.coverage === "none" ? (
              <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-black/15 bg-w p-10 text-center dark:border-white/15">
                <i className="ri-file-search-line text-4xl text-neutral-300 dark:text-neutral-600" />
                <p className="text-base font-semibold t-primary">{t("ask.coverage_none_title")}</p>
                <p className="max-w-md text-sm leading-6 text-neutral-500 dark:text-neutral-400">
                  {t("ask.coverage_none_desc", { question })}
                </p>
              </div>
            ) : (
              <>
                <article className="rounded-2xl bg-w p-5 md:p-6">
                  <Markdown content={response.answer} />
                  {response.verifiedAt ? (
                    <p className="mt-4 flex items-center gap-1.5 border-t border-black/5 pt-3 text-xs text-neutral-500 dark:border-white/5 dark:text-neutral-400">
                      <i className="ri-shield-check-line" />
                      {t("ask.verified_at", { date: response.verifiedAt })}
                    </p>
                  ) : null}
                </article>

                {citations.length > 0 ? (
                  <section aria-label={t("ask.citations")} className="flex flex-col gap-3">
                    <h2 className="text-lg font-bold t-primary">{t("ask.citations")}</h2>
                    {citations.map((citation, index) => (
                      <CitationCard key={`${citation.storySlug}-${index}`} citation={citation} index={index} />
                    ))}
                  </section>
                ) : null}

                <RelatedList items={related} loading={relatedLoading} />
              </>
            )}
          </div>
        ) : null}
      </main>
    </>
  );
}
