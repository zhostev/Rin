/**
 * Stage 3 · 聚合分析事件。
 *
 * POST /api/events（公开）
 *   body {type: 'video_play'|'audio_play'|'story_read'|'media_view', assetId?, storyId?}
 *   只做聚合统计，不收任何 PII（不收 IP / UA / cookie），只记事件类型 +
 *   可选的 asset_id / story_id，写入 media_events。
 *   限流宽松：单 isolate 每分钟 300 次的软上限，超了回 429（个人站点正常
 *   流量远碰不到；Cloudflare 侧另有平台级防护）。
 *
 * GET /api/events/daily?type=&days=30（公开只读）
 *   按天聚合计数，days∈[1,365] 默认 30。返回
 *   {days, from, to, data: [{date, total, counts: {video_play, audio_play, story_read, media_view}}]}
 *   缺数据的天补 0，前端可直接画图。
 */
import { Hono } from "hono";
import type { AppContext, Variables } from "../../core/hono-types";
import {
    countEventsDaily,
    EVENT_TYPES,
    insertMediaEvent,
    isEventType,
    type EventType,
} from "./repository";

type HonoApp = Hono<{
    Bindings: Env;
    Variables: Variables;
}>;

const MAX_EVENTS_PER_MINUTE = 300;
const rateBuckets = new Map<number, number>();

/** 宽松的内存限流：按分钟桶计数。测试用 resetEventRateLimiter() 重置。 */
function checkRateLimit(): boolean {
    const bucket = Math.floor(Date.now() / 60_000);
    for (const key of rateBuckets.keys()) {
        if (key < bucket - 1) {
            rateBuckets.delete(key);
        }
    }
    const current = rateBuckets.get(bucket) ?? 0;
    if (current >= MAX_EVENTS_PER_MINUTE) {
        return false;
    }
    rateBuckets.set(bucket, current + 1);
    return true;
}

export function resetEventRateLimiter(): void {
    rateBuckets.clear();
}

function errorJson(c: AppContext, code: string, message: string, status: 400 | 429) {
    return c.json({ error: { code, message } }, status);
}

function parsePositiveInt(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function dayKey(date: Date): string {
    return date.toISOString().slice(0, 10);
}

export function EventsService(): HonoApp {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();

    // POST /events
    app.post("/", async (c) => {
        if (!checkRateLimit()) {
            return errorJson(c, "event_rate_limited", "Too many events, slow down", 429);
        }

        let body: unknown;
        try {
            body = await c.req.json();
        } catch {
            return errorJson(c, "event_invalid_body", "Request body must be JSON", 400);
        }
        const payload = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

        if (!isEventType(payload.type)) {
            return errorJson(
                c,
                "event_invalid_type",
                `type must be one of ${EVENT_TYPES.join("|")}`,
                400,
            );
        }

        let assetId: number | null = null;
        if (payload.assetId !== undefined) {
            assetId = parsePositiveInt(payload.assetId);
            if (assetId === null) {
                return errorJson(c, "event_invalid_asset_id", "assetId must be a positive integer", 400);
            }
        }
        let storyId: number | null = null;
        if (payload.storyId !== undefined) {
            storyId = parsePositiveInt(payload.storyId);
            if (storyId === null) {
                return errorJson(c, "event_invalid_story_id", "storyId must be a positive integer", 400);
            }
        }

        const db = c.get("db");
        await insertMediaEvent(db, payload.type, assetId, storyId);
        return c.json({ ok: true }, 201);
    });

    // GET /events/daily
    app.get("/daily", async (c) => {
        const typeParam = c.req.query("type");
        if (typeParam !== undefined && !isEventType(typeParam)) {
            return errorJson(c, "event_invalid_type", `type must be one of ${EVENT_TYPES.join("|")}`, 400);
        }
        const type = typeParam as EventType | undefined;

        const daysParam = c.req.query("days");
        let days = 30;
        if (daysParam !== undefined && daysParam !== "") {
            const parsed = Number.parseInt(daysParam, 10);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
                return errorJson(c, "event_invalid_days", "days must be an integer between 1 and 365", 400);
            }
            days = parsed;
        }

        const db = c.get("db");
        const cutoff = new Date(Date.now() - days * 86_400_000);
        const counts = await countEventsDaily(db, cutoff, type);

        const byDay = new Map<string, Map<string, number>>();
        for (const row of counts) {
            let entry = byDay.get(row.day);
            if (!entry) {
                entry = new Map();
                byDay.set(row.day, entry);
            }
            entry.set(row.eventType, row.count);
        }

        const data = [];
        const today = new Date();
        for (let i = days - 1; i >= 0; i--) {
            const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
            const key = dayKey(date);
            const entry = byDay.get(key);
            const typeCounts: Record<string, number> = {};
            let total = 0;
            for (const eventType of EVENT_TYPES) {
                const n = entry?.get(eventType) ?? 0;
                typeCounts[eventType] = n;
                total += n;
            }
            data.push({ date: key, total, counts: typeCounts });
        }

        return c.json({
            days,
            from: data[0]?.date ?? null,
            to: data[data.length - 1]?.date ?? null,
            data,
        });
    });

    return app;
}
