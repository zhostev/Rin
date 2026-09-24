/**
 * Stage 3 · 媒体中心列表 API。
 *
 * GET /api/media（公开，无需登录）
 *   查询参数：type=video|audio|image（gallery 视为 image）、storyId、year、
 *             minDuration、maxDuration、updated、page、limit
 *             （updated 三态：true=只看有更新的，false=只看未更新的，缺省=不过滤）
 *   返回 {size, data, hasNext}（沿用站内现有分页 shape）。
 *
 * item: {id, kind, title, duration, width, height, streamUid, streamStatus,
 *        thumbnailUrl, publicUrl, storyId, storySlug, storyTitle, year, updatedAt}
 *
 * 规则：
 * - 只返回有所属 story 且 story status=published/updated 的资产
 *   （updated 是发布后的旧文维护，同样公开可见）；
 * - video 的 streamStatus 原样透传 DB 值：无真实 Stream token 时转码
 *   不会完成，status 自然非 ready，前端据此降级显示封面+状态，后端不报错；
 * - year 按归属 story 的 publishedAt 年份过滤；
 * - updated=true 命中 story.status=updated 或资产 updatedAt>createdAt 的资产。
 */
import { Hono } from "hono";
import type { AppContext, Variables } from "../../core/hono-types";
import { serializeMediaAsset } from "../media/asset";
import type { MediaAssetRow } from "../media/repository";
import { parseOptionalInteger, parsePositiveInteger, parseUpdatedFlag } from "./params";
import {
    buildAssetStoryMap,
    findPublishedAssets,
    VISIBLE_STORY_STATUSES,
    type AssetStoryInfo,
} from "./repository";

type HonoApp = Hono<{
    Bindings: Env;
    Variables: Variables;
}>;

const MEDIA_TYPES = ["video", "audio", "image"] as const;
type MediaTypeFilter = (typeof MEDIA_TYPES)[number];

function kindsForType(type: MediaTypeFilter): string[] {
    // gallery 视为 image：前端按 story 做图集聚合，后端这里合并返回
    if (type === "image") {
        return ["image", "gallery"];
    }
    return [type];
}

function errorJson(c: AppContext, code: string, message: string, status: 400) {
    return c.json({ error: { code, message } }, status);
}

function isUpdatedAsset(row: MediaAssetRow, info: AssetStoryInfo): boolean {
    if (info.storyStatus === "updated") {
        return true;
    }
    const created = row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt);
    const updated = row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt);
    return updated > created;
}

export interface MediaCenterItem {
    id: number;
    kind: string;
    title: string | null;
    duration: number | null;
    width: number | null;
    height: number | null;
    streamUid: string | null;
    streamStatus: string | null;
    thumbnailUrl: string | null;
    publicUrl: string | null;
    storyId: number;
    storySlug: string;
    storyTitle: string | null;
    year: number | null;
    updatedAt: string;
}

function serializeItem(row: MediaAssetRow, info: AssetStoryInfo): MediaCenterItem {
    const wire = serializeMediaAsset(row);
    const imageLike = row.kind === "image" || row.kind === "gallery";
    return {
        id: row.id,
        kind: row.kind,
        title: row.title || null,
        duration: row.duration ?? null,
        width: row.width ?? null,
        height: row.height ?? null,
        streamUid: row.streamUid || null,
        // 非 stream 源的资产没有转码状态概念，透传 null 而不是 DB 默认的 'ready'
        streamStatus: row.source === "stream" ? (wire.stream_status ?? null) : null,
        thumbnailUrl: wire.thumbnail_url ?? (imageLike ? (wire.url ?? null) : null),
        publicUrl: wire.url ?? null,
        storyId: info.storyId,
        storySlug: info.storySlug,
        storyTitle: info.storyTitle,
        year: info.publishedAt ? info.publishedAt.getFullYear() : null,
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    };
}

export function MediaCenterService(): HonoApp {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();

    // GET /media
    app.get("/", async (c) => {
        const db = c.get("db");

        const typeParam = c.req.query("type");
        if (typeParam !== undefined && !(MEDIA_TYPES as readonly string[]).includes(typeParam)) {
            return errorJson(c, "media_invalid_type", "type must be one of video|audio|image", 400);
        }

        const storyId = parseOptionalInteger(c.req.query("storyId"));
        const year = parseOptionalInteger(c.req.query("year"));
        const minDuration = parseOptionalInteger(c.req.query("minDuration"));
        const maxDuration = parseOptionalInteger(c.req.query("maxDuration"));
        const page = parsePositiveInteger(c.req.query("page"), 1);
        const limit = parsePositiveInteger(c.req.query("limit"), 20, 100);

        for (const [name, value] of [
            ["storyId", storyId],
            ["year", year],
            ["minDuration", minDuration],
            ["maxDuration", maxDuration],
            ["page", page],
            ["limit", limit],
        ] as const) {
            if (typeof value === "number" && Number.isNaN(value)) {
                return errorJson(c, "media_invalid_param", `${name} must be a positive integer`, 400);
            }
        }

        const updatedFilter = parseUpdatedFlag(c.req.query("updated"));
        if (updatedFilter === "invalid") {
            return errorJson(c, "media_invalid_param", "updated must be true or false", 400);
        }

        const storyMap = await buildAssetStoryMap(db, VISIBLE_STORY_STATUSES);
        let ids = [...storyMap.keys()];
        if (storyId !== undefined) {
            ids = ids.filter((id) => storyMap.get(id)?.storyId === storyId);
        }

        const rows = await findPublishedAssets(db, {
            ids,
            kinds: typeParam ? kindsForType(typeParam as MediaTypeFilter) : undefined,
            minDuration,
            maxDuration,
        });

        let items = rows
            .map((row) => ({ row, info: storyMap.get(row.id)! }))
            .filter(({ info }) => info !== undefined)
            .map(({ row, info }) => ({ item: serializeItem(row, info), row, info }));

        if (year !== undefined) {
            items = items.filter(({ item }) => item.year === year);
        }
        if (updatedFilter === true) {
            items = items.filter(({ row, info }) => isUpdatedAsset(row, info));
        } else if (updatedFilter === false) {
            items = items.filter(({ row, info }) => !isUpdatedAsset(row, info));
        }

        const data = items.map(({ item }) => item);
        const size = data.length;
        const offset = (page - 1) * limit;
        const pageData = data.slice(offset, offset + limit);

        return c.json({ size, data: pageData, hasNext: offset + limit < size });
    });

    return app;
}
