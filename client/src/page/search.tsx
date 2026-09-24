import { useEffect, useRef, useState } from "react"
import { Helmet } from 'react-helmet'
import { useTranslation } from "react-i18next"
import { Link, useSearch } from "wouter"
import { FeedCard } from "../components/feed_card"
import { Waiting } from "../components/loading"
import { client } from "../app/runtime"
import type { SearchWithTranscripts, TranscriptHit } from "../api/media-center"
import { formatDuration } from "../components/story-blocks"

import { useSiteConfig } from "../hooks/useSiteConfig";
import { siteName } from "../utils/constants"
import { tryInt } from "../utils/int"

type FeedsData = {
    size: number,
    data: any[],
    hasNext: boolean
}

/** One transcript hit: snippet + timecode chips linking into the story's media (?t=). */
function TranscriptHitCard({ hit }: { hit: TranscriptHit }) {
    const { t } = useTranslation()
    const segments = Array.isArray(hit.segments) ? hit.segments : []
    return (
        <article className="rounded-2xl bg-w p-4">
            <Link
                href={`/story/${hit.storySlug}`}
                className="font-medium t-primary hover:text-theme"
            >
                {hit.storyTitle}
            </Link>
            {hit.snippet &&
                <p className="mt-1.5 text-sm leading-6 t-secondary line-clamp-3">
                    {hit.snippet}
                </p>
            }
            {segments.length > 0 &&
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {segments.slice(0, 6).map((segment, index) => (
                        <Link
                            key={index}
                            href={`/story/${hit.storySlug}?t=${Math.floor(segment.start)}&asset=${encodeURIComponent(String(hit.assetId))}`}
                            title={segment.text}
                            className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 font-mono text-xs text-theme hover:underline"
                        >
                            <i className="ri-time-line" />
                            {formatDuration(segment.start)}
                        </Link>
                    ))}
                    {segments.length > 6 &&
                        <span className="inline-flex items-center px-1 text-xs text-neutral-400">
                            {t('article.search.transcripts$more', { count: segments.length - 6 })}
                        </span>
                    }
                </div>
            }
        </article>
    )
}

export function SearchPage({ keyword }: { keyword: string }) {
    const { t } = useTranslation()
    const siteConfig = useSiteConfig();
    const query = new URLSearchParams(useSearch());
    const [status, setStatus] = useState<'loading' | 'idle'>('idle')
    const [feeds, setFeeds] = useState<FeedsData>()
    const [transcripts, setTranscripts] = useState<TranscriptHit[]>([])
    const page = tryInt(1, query.get("page"))
    const limit = tryInt(siteConfig.pageSize, query.get("limit"))
    const feedListClass = siteConfig.feedLayout === "masonry" ? "wauto columns-1 gap-5 md:columns-2" : "wauto flex flex-col";
    const feedData = Array.isArray(feeds?.data) ? feeds.data : [];
    const ref = useRef("")
    function fetchFeeds() {
        if (!keyword) return
        client.search.search(keyword, {
            page,
            limit,
        }).then(({ data }) => {
            if (data) {
                setFeeds(data)
                const withTranscripts = data as SearchWithTranscripts
                setTranscripts(Array.isArray(withTranscripts.transcripts) ? withTranscripts.transcripts : [])
                setStatus('idle')
            }
        })
    }
    useEffect(() => {
        const key = `${page} ${limit} ${keyword}`
        if (ref.current == key) return
        setStatus('loading')
        fetchFeeds()
        ref.current = key
    }, [page, limit, keyword])
    const title = t('article.search.title$keyword', { keyword })
    return (
        <>
            <Helmet>
                <title>{`${title} - ${siteConfig.name}`}</title>
                <meta property="og:site_name" content={siteName} />
                <meta property="og:title" content={title} />
                <meta property="og:image" content={siteConfig.avatar} />
                <meta property="og:type" content="article" />
                <meta property="og:url" content={document.URL} />
            </Helmet>
            <Waiting for={status === 'idle'}>
                <main className="w-full flex flex-col justify-center items-center mb-8">
                    <div className="wauto text-start text-black dark:text-white py-4 text-4xl font-bold">
                        <p>
                            {t('article.search.title')}
                        </p>
                        <div className="flex flex-row justify-between">
                            <p className="text-sm mt-4 text-neutral-500 font-normal">
                                {t('article.total$count', { count: feeds?.size })}
                            </p>
                        </div>
                    </div>
                    <Waiting for={status === 'idle'}>
                        <div className={feedListClass}>
                            {feedData.map(({ id, ...feed }: any) => (
                                <FeedCard key={id} id={id} {...feed} />
                            ))}
                        </div>
                        {transcripts.length > 0 &&
                            <section aria-label={t('article.search.transcripts')} className="wauto mt-8">
                                <h2 className="text-xl font-bold t-primary mb-3">
                                    {t('article.search.transcripts')}
                                </h2>
                                <div className="flex flex-col gap-3">
                                    {transcripts.map((hit, index) => (
                                        <TranscriptHitCard key={`${hit.assetId}-${index}`} hit={hit} />
                                    ))}
                                </div>
                            </section>
                        }
                        <div className="wauto flex flex-row items-center mt-4 ani-show">
                            {page > 1 &&
                                <Link href={`?page=${(page - 1)}&limit=${limit}`}
                                    className={`text-sm font-normal rounded-full px-4 py-2 text-white bg-theme`}>
                                    {t('previous')}
                                </Link>
                            }
                            <div className="flex-1" />
                            {feeds?.hasNext &&
                                <Link href={`?page=${(page + 1)}&limit=${limit}`}
                                    className={`text-sm font-normal rounded-full px-4 py-2 text-white bg-theme`}>
                                    {t('next')}
                                </Link>
                            }
                        </div>
                    </Waiting>
                </main>
            </Waiting>
        </>
    )
}
