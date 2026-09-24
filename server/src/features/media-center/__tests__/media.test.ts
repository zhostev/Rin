import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from "hono";
import type { Database } from 'bun:sqlite';
import type { Variables } from "../../../core/hono-types";
import { setupTestApp, cleanupTestDB } from '../../../../tests/fixtures';
import { applyMediaCenterMigration } from '../../../../tests/fixtures/media-center';
import { MediaCenterService } from '../media-routes';

async function setup() {
    const ctx = await setupTestApp(() => MediaCenterService());
    applyMediaCenterMigration(ctx.sqlite);
    return ctx;
}

function seed(sqlite: Database) {
    sqlite.exec(`
        INSERT INTO stories (id, slug, title, status, published_at, updated_at) VALUES
            (1, 'pub-story', 'Published Story', 'published', 1717200000, 1717200000),
            (2, 'upd-story', 'Updated Story', 'updated', 1742000000, 1742086400),
            (3, 'draft-story', 'Draft Story', 'draft', NULL, 1742000000);

        INSERT INTO media_assets
            (id, kind, source, title, duration, width, height, stream_uid, stream_status, r2_key, images_id, images_variants_json, created_at, updated_at) VALUES
            (10, 'video', 'stream', 'Talk video', 600, 1920, 1080, 'uid-abc', 'uploading', NULL, '', '{}', 1742000000, 1742000000),
            (11, 'audio', 'r2', 'Podcast ep', 1800, NULL, NULL, NULL, 'ready', 'audio/ep1.mp3', '', '{}', 1742000000, 1742086400),
            (12, 'image', 'cloudflare_images', 'Cover', NULL, 800, 600, NULL, 'ready', NULL, 'img-1', '{"medium":"https://imagedelivery.net/acc/img-1/medium"}', 1742000000, 1742000000),
            (13, 'gallery', 'cloudflare_images', 'Set', NULL, NULL, NULL, NULL, 'ready', NULL, 'img-2', '{"medium":"https://imagedelivery.net/acc/img-2/medium"}', 1742000000, 1742000000),
            (14, 'video', 'stream', 'Draft video', 300, NULL, NULL, 'uid-draft', 'ready', NULL, '', '{}', 1742000000, 1742000000),
            (15, 'audio', 'r2', 'Orphan audio', 120, NULL, NULL, NULL, 'ready', 'audio/orphan.mp3', '', '{}', 1742000000, 1742000000);

        INSERT INTO content_blocks (story_id, type, position, payload_json) VALUES
            (1, 'video', 0, '{"asset_id":10}'),
            (1, 'audio', 1, '{"asset_id":11,"asset":{"id":11}}'),
            (1, 'image', 2, '{"asset_id":12}'),
            (2, 'gallery', 0, '{"asset_id":13}'),
            (3, 'video', 0, '{"asset_id":14}'),
            (1, 'rich_text', 3, '{"markdown":"hello"}');
    `);
}

describe('MediaCenterService GET /', () => {
    let app: Hono<{ Bindings: Env; Variables: Variables }>;
    let sqlite: Database;
    let env: Env;

    beforeEach(async () => {
        const ctx = await setup();
        app = ctx.app;
        sqlite = ctx.sqlite;
        env = ctx.env;
        seed(sqlite);
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });

    it('returns only assets attached to published/updated stories', async () => {
        const res = await app.request('/', {}, env);
        const body = await res.json() as any;

        expect(res.status).toBe(200);
        expect(body.size).toBe(4);
        expect(body.hasNext).toBe(false);
        const ids = body.data.map((item: any) => item.id).sort();
        expect(ids).toEqual([10, 11, 12, 13]); // 14 草稿、15 无归属 被排除
    });

    it('serializes the full item shape with story linkage', async () => {
        const res = await app.request('/?type=video', {}, env);
        const body = await res.json() as any;

        expect(body.data).toHaveLength(1);
        const item = body.data[0];
        expect(item).toMatchObject({
            id: 10,
            kind: 'video',
            title: 'Talk video',
            duration: 600,
            width: 1920,
            height: 1080,
            streamUid: 'uid-abc',
            // 无真实 Stream token：转码未完成，status 透传 uploading，后端不报错
            streamStatus: 'uploading',
            storyId: 1,
            storySlug: 'pub-story',
            storyTitle: 'Published Story',
            year: 2024,
        });
        expect(item.thumbnailUrl).toBe('https://videodelivery.net/uid-abc/thumbnails/thumbnail.jpg');
        expect(item.publicUrl).toBe('https://videodelivery.net/uid-abc/manifest/video.m3u8');
        expect(typeof item.updatedAt).toBe('string');
    });

    it('derives image publicUrl from Images variants and nulls streamStatus for r2', async () => {
        const res = await app.request('/?storyId=1', {}, env);
        const body = await res.json() as any;
        const audio = body.data.find((item: any) => item.id === 11);
        const image = body.data.find((item: any) => item.id === 12);

        expect(audio.streamStatus).toBeNull();
        expect(audio.publicUrl).toBe('/api/blob/audio/ep1.mp3');
        expect(image.publicUrl).toBe('https://imagedelivery.net/acc/img-1/medium');
        expect(image.thumbnailUrl).toBe('https://imagedelivery.net/acc/img-1/medium');
    });

    it('treats gallery as image', async () => {
        const res = await app.request('/?type=image', {}, env);
        const body = await res.json() as any;
        const ids = body.data.map((item: any) => item.id).sort();
        expect(ids).toEqual([12, 13]);
    });

    it('filters by storyId and year', async () => {
        const byStory = await (await app.request('/?storyId=2', {}, env)).json() as any;
        expect(byStory.data.map((i: any) => i.id)).toEqual([13]);

        const y2024 = await (await app.request('/?year=2024', {}, env)).json() as any;
        expect(y2024.data.map((i: any) => i.id).sort()).toEqual([10, 11, 12]);

        const y2025 = await (await app.request('/?year=2025', {}, env)).json() as any;
        expect(y2025.data.map((i: any) => i.id)).toEqual([13]);
    });

    it('filters by duration range', async () => {
        const min = await (await app.request('/?minDuration=1000', {}, env)).json() as any;
        expect(min.data.map((i: any) => i.id)).toEqual([11]);

        const max = await (await app.request('/?maxDuration=700', {}, env)).json() as any;
        expect(max.data.map((i: any) => i.id).sort()).toEqual([10, 12, 13]);
    });

    it('updated=true only returns updated stories or touched assets', async () => {
        const res = await app.request('/?updated=true', {}, env);
        const body = await res.json() as any;
        // 13：story status=updated；11：资产 updatedAt > createdAt
        expect(body.data.map((i: any) => i.id).sort()).toEqual([11, 13]);
    });

    it('updated=false only returns not-updated assets', async () => {
        const res = await app.request('/?updated=false', {}, env);
        const body = await res.json() as any;
        expect(body.data.map((i: any) => i.id).sort()).toEqual([10, 12]);
    });

    it('rejects an invalid updated value with 400', async () => {
        const res = await app.request('/?updated=yes', {}, env);
        expect(res.status).toBe(400);
        const body = await res.json() as any;
        expect(body.error.code).toBe('media_invalid_param');
    });

    it('paginates with the {size,data,hasNext} shape', async () => {
        const first = await (await app.request('/?page=1&limit=2', {}, env)).json() as any;
        expect(first.size).toBe(4);
        expect(first.data).toHaveLength(2);
        expect(first.hasNext).toBe(true);

        const second = await (await app.request('/?page=2&limit=2', {}, env)).json() as any;
        expect(second.size).toBe(4);
        expect(second.data).toHaveLength(2);
        expect(second.hasNext).toBe(false);
    });

    it('rejects invalid filter values with 400', async () => {
        for (const path of ['/?type=bogus', '/?storyId=abc', '/?year=abc', '/?page=0', '/?limit=-1']) {
            const res = await app.request(path, {}, env);
            expect(res.status).toBe(400);
            const body = await res.json() as any;
            expect(body.error.code).toMatch(/^media_invalid_/);
        }
    });
});
