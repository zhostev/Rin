/**
 * Stage 3 · 专题 API。
 *
 * GET /api/series/:slug（公开）
 * 返回 {series: {id, slug, title, summary},
 *       stories: [{storyId, slug, title, status, position, publishedAt, updatedAt, coverUrl?}],
 *       completion: {total, published},
 *       recentUpdates: [{storySlug, title, updatedAt}]}（最近更新的 5 个 story）
 *
 * stories 按 story_series.position 排序；stories 列表不过滤 status，
 * completion.published 统计其中 status=published 的数量。
 */
import { Hono } from "hono";
import type { Variables } from "../../core/hono-types";
import { serializeMediaAsset } from "../media/asset";
import { findAssetsByIds, findSeriesBySlug, listSeriesStories } from "./repository";

type HonoApp = Hono<{
    Bindings: Env;
    Variables: Variables;
}>;

function toIso(value: Date | null): string | null {
    if (!value) {
        return null;
    }
    return value instanceof Date ? value.toISOString() : String(value);
}

export function SeriesService(): HonoApp {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();

    // GET /series/:slug
    app.get("/:slug", async (c) => {
        const db = c.get("db");
        const slug = c.req.param("slug");

        const s = await findSeriesBySlug(db, slug);
        if (!s) {
            return c.json({ error: { code: "series_not_found", message: "Series not found" } }, 404);
        }

        const links = await listSeriesStories(db, s.id);

        const coverIds = links
            .map((link) => link.coverAssetId)
            .filter((id): id is number => typeof id === "number");
        const coverAssets = await findAssetsByIds(db, coverIds);

        const stories = links.map((link) => {
            const cover = link.coverAssetId ? coverAssets.get(link.coverAssetId) : undefined;
            const story: Record<string, unknown> = {
                storyId: link.storyId,
                slug: link.slug,
                title: link.title,
                status: link.status,
                position: link.position,
                publishedAt: toIso(link.publishedAt),
                updatedAt: toIso(link.updatedAt),
            };
            if (cover) {
                const url = serializeMediaAsset(cover).url;
                if (url) {
                    story.coverUrl = url;
                }
            }
            return story;
        });

        const recentUpdates = [...links]
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
            .slice(0, 5)
            .map((link) => ({
                storySlug: link.slug,
                title: link.title,
                updatedAt: toIso(link.updatedAt),
            }));

        return c.json({
            series: {
                id: s.id,
                slug: s.slug,
                title: s.title,
                summary: s.summary,
            },
            stories,
            completion: {
                total: links.length,
                published: links.filter((link) => link.status === "published").length,
            },
            recentUpdates,
        });
    });

    return app;
}
