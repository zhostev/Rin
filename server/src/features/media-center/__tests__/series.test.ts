import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from "hono";
import type { Database } from 'bun:sqlite';
import type { Variables } from "../../../core/hono-types";
import { setupTestApp, cleanupTestDB } from '../../../../tests/fixtures';
import { applyMediaCenterMigration } from '../../../../tests/fixtures/media-center';
import { SeriesService } from '../series-routes';

function seed(sqlite: Database) {
    sqlite.exec(`
        INSERT INTO series (id, slug, title, summary) VALUES
            (1, 'deep-dive', 'Deep Dive', 'A slow series');

        INSERT INTO stories (id, slug, title, status, cover_asset_id, published_at, updated_at) VALUES
            (1, 'part-one', 'Part One', 'published', 12, 1717200000, 1717200000),
            (2, 'part-two', 'Part Two', 'updated', NULL, 1742000000, 1742086400),
            (3, 'part-three', 'Part Three', 'draft', NULL, NULL, 1742172800);

        INSERT INTO story_series (series_id, story_id, position) VALUES
            (1, 1, 0),
            (1, 2, 1),
            (1, 3, 2);

        INSERT INTO media_assets (id, kind, source, title, images_id, images_variants_json, created_at, updated_at) VALUES
            (12, 'image', 'cloudflare_images', 'Cover', 'img-1', '{"medium":"https://imagedelivery.net/acc/img-1/medium"}', 1742000000, 1742000000);
    `);
}

describe('SeriesService GET /:slug', () => {
    let app: Hono<{ Bindings: Env; Variables: Variables }>;
    let sqlite: Database;
    let env: Env;

    beforeEach(async () => {
        const ctx = await setupTestApp(() => SeriesService());
        applyMediaCenterMigration(ctx.sqlite);
        app = ctx.app;
        sqlite = ctx.sqlite;
        env = ctx.env;
        seed(sqlite);
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });

    it('returns the series with stories ordered by position', async () => {
        const res = await app.request('/deep-dive', {}, env);
        const body = await res.json() as any;

        expect(res.status).toBe(200);
        expect(body.series).toMatchObject({ id: 1, slug: 'deep-dive', title: 'Deep Dive', summary: 'A slow series' });
        expect(body.stories).toHaveLength(3);
        expect(body.stories.map((s: any) => s.slug)).toEqual(['part-one', 'part-two', 'part-three']);
        expect(body.stories[0]).toMatchObject({
            storyId: 1,
            slug: 'part-one',
            title: 'Part One',
            status: 'published',
            position: 0,
            coverUrl: 'https://imagedelivery.net/acc/img-1/medium',
        });
        // 无封面的 story 不带 coverUrl 键
        expect('coverUrl' in body.stories[1]).toBe(false);
        expect(typeof body.stories[0].updatedAt).toBe('string');
    });

    it('computes completion and recentUpdates', async () => {
        const res = await app.request('/deep-dive', {}, env);
        const body = await res.json() as any;

        expect(body.completion).toEqual({ total: 3, published: 1 });
        // 最近更新的 5 个 story：按 updatedAt 倒序（part-three 草稿也计入）
        expect(body.recentUpdates.map((u: any) => u.storySlug)).toEqual(['part-three', 'part-two', 'part-one']);
        expect(body.recentUpdates[0]).toMatchObject({ storySlug: 'part-three', title: 'Part Three' });
        expect(typeof body.recentUpdates[0].updatedAt).toBe('string');
    });

    it('returns 404 for an unknown slug', async () => {
        const res = await app.request('/nope', {}, env);
        expect(res.status).toBe(404);
        const body = await res.json() as any;
        expect(body.error.code).toBe('series_not_found');
    });
});
