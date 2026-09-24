import { describe, it, expect, afterEach } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { setupTestApp, cleanupTestDB } from '../../../../tests/fixtures';
import { applyMediaCenterMigration } from '../../../../tests/fixtures/media-center';
import { MediaCenterService } from '../media-routes';

async function setup() {
    const ctx = await setupTestApp(() => MediaCenterService());
    applyMediaCenterMigration(ctx.sqlite);
    ctx.sqlite.exec(`
        INSERT INTO media_assets
            (id, kind, source, title, duration, width, height, stream_uid, stream_status, r2_key, images_id, images_variants_json, created_at, updated_at) VALUES
            (1, 'video', 'r2', 'R2 clip', 5, 640, 360, NULL, 'ready', 'media/original/1/test-small.mp4', '', '{}', 1742000000, 1742000000),
            (2, 'video', 'stream', 'Stream clip', 600, 1920, 1080, 'uid-abc', 'ready', NULL, '', '{}', 1742000000, 1742000000),
            (3, 'image', 'cloudflare_images', 'Cover', NULL, 800, 600, NULL, 'ready', NULL, 'img-1', '{"medium":"https://imagedelivery.net/acc/img-1/medium"}', 1742000000, 1742000000),
            (4, 'audio', 'r2', 'Silent', 10, NULL, NULL, NULL, 'ready', NULL, '', '{}', 1742000000, 1742000000);
    `);
    return ctx;
}

describe('GET /:id/playback', () => {
    let sqlite: Database;

    afterEach(() => {
        if (sqlite) cleanupTestDB(sqlite);
    });

    it('redirects an r2 asset to its blob URL', async () => {
        const ctx = await setup();
        sqlite = ctx.sqlite;
        const res = await ctx.app.request('/1/playback', {}, ctx.env);
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/api/blob/media/original/1/test-small.mp4');
    });

    it('redirects a stream asset to its HLS manifest URL', async () => {
        const ctx = await setup();
        sqlite = ctx.sqlite;
        const res = await ctx.app.request('/2/playback', {}, ctx.env);
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('https://videodelivery.net/uid-abc/manifest/video.m3u8');
    });

    it('redirects a cloudflare_images asset to its variant URL', async () => {
        const ctx = await setup();
        sqlite = ctx.sqlite;
        const res = await ctx.app.request('/3/playback', {}, ctx.env);
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('https://imagedelivery.net/acc/img-1/medium');
    });

    it('returns 404 for an asset with no playback URL', async () => {
        const ctx = await setup();
        sqlite = ctx.sqlite;
        const res = await ctx.app.request('/4/playback', {}, ctx.env);
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('MEDIA_NOT_PLAYABLE');
    });

    it('returns 404 for a missing asset', async () => {
        const ctx = await setup();
        sqlite = ctx.sqlite;
        const res = await ctx.app.request('/999/playback', {}, ctx.env);
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 for a non-numeric id', async () => {
        const ctx = await setup();
        sqlite = ctx.sqlite;
        const res = await ctx.app.request('/abc/playback', {}, ctx.env);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('media_invalid_id');
    });
});
