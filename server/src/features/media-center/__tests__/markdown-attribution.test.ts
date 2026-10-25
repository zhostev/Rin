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
            (1, 'md-story', 'Markdown Story', 'published', 1717200000, 1717200000);

        INSERT INTO media_assets
            (id, kind, source, title, duration, width, height, stream_uid, stream_status, r2_key, images_id, images_variants_json, created_at, updated_at) VALUES
            (16, 'image', 'r2', 'First', NULL, 800, 600, NULL, 'ready', 'img/first.jpg', '', '{}', 1742000000, 1742000000),
            (17, 'image', 'r2', 'Second', NULL, 800, 600, NULL, 'ready', 'img/second.jpg', '', '{}', 1742000000, 1742000000),
            (18, 'image', 'r2', 'Mentioned only', NULL, 800, 600, NULL, 'ready', 'img/mentioned.jpg', '', '{}', 1742000000, 1742000000);

        INSERT INTO content_blocks (story_id, type, position, payload_json) VALUES
            (1, 'rich_text', 0, '{"markdown":"![First](/api/media/16/playback)\\n\\n![Second](/api/media/17/playback)"}'),
            (1, 'rich_text', 1, '{"markdown":"see /api/media/18/playback for details"}');
    `);
}

describe('MediaCenterService markdown-image attribution', () => {
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

    it('attributes assets linked by rich_text markdown images to the published story', async () => {
        const res = await app.request('/?type=image', {}, env);
        const body = await res.json() as any;

        expect(res.status).toBe(200);
        const ids = body.data.map((item: any) => item.id).sort();
        expect(ids).toEqual([16, 17]);
        expect(body.data.map((item: any) => item.storySlug)).toEqual(['md-story', 'md-story']);
    });

    it('does not attribute a playback URL merely mentioned in prose', async () => {
        const res = await app.request('/?type=image', {}, env);
        const body = await res.json() as any;
        const ids = body.data.map((item: any) => item.id);
        expect(ids).not.toContain(18);
    });
});
