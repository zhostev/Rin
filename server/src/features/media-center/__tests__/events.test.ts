import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from "hono";
import type { Database } from 'bun:sqlite';
import type { Variables } from "../../../core/hono-types";
import { setupTestApp, cleanupTestDB } from '../../../../tests/fixtures';
import { applyMediaCenterMigration } from '../../../../tests/fixtures/media-center';
import { EventsService, resetEventRateLimiter } from '../events-routes';

describe('EventsService', () => {
    let app: Hono<{ Bindings: Env; Variables: Variables }>;
    let sqlite: Database;
    let env: Env;

    beforeEach(async () => {
        const ctx = await setupTestApp(() => EventsService());
        applyMediaCenterMigration(ctx.sqlite);
        app = ctx.app;
        sqlite = ctx.sqlite;
        env = ctx.env;
        resetEventRateLimiter();
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });

    async function post(body: unknown) {
        return app.request('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: typeof body === 'string' ? body : JSON.stringify(body),
        }, env);
    }

    it('records a valid event with 201', async () => {
        const res = await post({ type: 'video_play', assetId: 7, storyId: 3 });
        expect(res.status).toBe(201);
        expect((await res.json()) as any).toEqual({ ok: true });

        const row = sqlite.query(`SELECT event_type, asset_id, story_id FROM media_events`).get() as any;
        expect(row).toMatchObject({ event_type: 'video_play', asset_id: 7, story_id: 3 });
    });

    it('accepts events without assetId/storyId', async () => {
        const res = await post({ type: 'story_read' });
        expect(res.status).toBe(201);
        const row = sqlite.query(`SELECT asset_id, story_id FROM media_events`).get() as any;
        expect(row.asset_id).toBeNull();
        expect(row.story_id).toBeNull();
    });

    it('stores no PII columns', async () => {
        await post({ type: 'audio_play' });
        const columns = sqlite.query(`PRAGMA table_info(media_events)`).all() as Array<{ name: string }>;
        expect(columns.map((c) => c.name).sort()).toEqual(['asset_id', 'created_at', 'event_type', 'id', 'story_id']);
    });

    it('rejects invalid payloads with 400', async () => {
        const badType = await post({ type: 'click' });
        expect(badType.status).toBe(400);
        expect(((await badType.json()) as any).error.code).toBe('event_invalid_type');

        const badAsset = await post({ type: 'video_play', assetId: 'x' });
        expect(badAsset.status).toBe(400);

        const notJson = await post('not json{{{');
        expect(notJson.status).toBe(400);

        expect(sqlite.query(`SELECT COUNT(*) AS n FROM media_events`).get()).toMatchObject({ n: 0 });
    });

    it('aggregates daily counts with zero-filled days', async () => {
        await post({ type: 'video_play', storyId: 1 });
        await post({ type: 'video_play', storyId: 1 });
        await post({ type: 'audio_play', assetId: 9 });

        const res = await app.request('/daily', {}, env);
        expect(res.status).toBe(200);
        const body = await res.json() as any;

        expect(body.days).toBe(30);
        expect(body.data).toHaveLength(30);
        const today = body.data[body.data.length - 1];
        expect(today.total).toBe(3);
        expect(today.counts).toMatchObject({ video_play: 2, audio_play: 1, story_read: 0, media_view: 0 });
        // 昨天补 0
        expect(body.data[body.data.length - 2]).toMatchObject({ total: 0 });
        expect(body.from).toBe(body.data[0].date);
        expect(body.to).toBe(today.date);
    });

    it('supports type filter and custom days', async () => {
        await post({ type: 'video_play' });
        await post({ type: 'media_view' });

        const filtered = await (await app.request('/daily?type=video_play&days=7', {}, env)).json() as any;
        expect(filtered.days).toBe(7);
        expect(filtered.data).toHaveLength(7);
        const today = filtered.data[6];
        expect(today.counts.video_play).toBe(1);
        expect(today.total).toBe(1);

        const badType = await app.request('/daily?type=bogus', {}, env);
        expect(badType.status).toBe(400);

        for (const days of ['0', '366', 'abc']) {
            const res = await app.request(`/daily?days=${days}`, {}, env);
            expect(res.status).toBe(400);
        }
    });
});
