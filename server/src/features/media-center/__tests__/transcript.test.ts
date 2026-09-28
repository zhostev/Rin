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
            (3, 'draft-story', 'Draft Story', 'draft', NULL, 1742000000);

        INSERT INTO media_assets
            (id, kind, source, title, duration, width, height, stream_uid, stream_status, r2_key, images_id, images_variants_json, created_at, updated_at) VALUES
            (11, 'audio', 'r2', 'Podcast ep', 1800, NULL, NULL, NULL, 'ready', 'audio/ep1.mp3', '', '{}', 1742000000, 1742086400),
            (12, 'audio', 'r2', 'No transcript', 300, NULL, NULL, NULL, 'ready', 'audio/ep2.mp3', '', '{}', 1742000000, 1742000000),
            (14, 'audio', 'r2', 'Draft audio', 300, NULL, NULL, NULL, 'ready', 'audio/draft.mp3', '', '{}', 1742000000, 1742000000),
            (15, 'audio', 'r2', 'Orphan audio', 120, NULL, NULL, NULL, 'ready', 'audio/orphan.mp3', '', '{}', 1742000000, 1742000000);

        INSERT INTO content_blocks (story_id, type, position, payload_json) VALUES
            (1, 'audio', 0, '{"asset_id":11}'),
            (1, 'audio', 1, '{"asset_id":12}'),
            (3, 'audio', 0, '{"asset_id":14}');

        INSERT INTO transcripts (asset_id, language, text, segments_json, status) VALUES
            (11, 'zh', '全文转录文本', '[{"start":0,"end":12,"text":"开场白"}]', 'draft');
    `);
}

describe('MediaCenterService transcripts', () => {
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

    it('marks hasTranscript on list items', async () => {
        const res = await app.request('/?type=audio', {}, env);
        const body = await res.json() as any;

        expect(res.status).toBe(200);
        const withTranscript = body.data.find((item: any) => item.id === 11);
        const withoutTranscript = body.data.find((item: any) => item.id === 12);
        expect(withTranscript.hasTranscript).toBe(true);
        expect(withoutTranscript.hasTranscript).toBe(false);
    });

    it('GET /:id/transcript returns text and segments', async () => {
        const res = await app.request('/11/transcript', {}, env);
        const body = await res.json() as any;

        expect(res.status).toBe(200);
        expect(body).toMatchObject({
            assetId: 11,
            language: 'zh',
            text: '全文转录文本',
        });
        expect(body.segments).toEqual([{ start: 0, end: 12, text: '开场白' }]);
    });

    it('GET /:id/transcript 404s without a transcript', async () => {
        const res = await app.request('/12/transcript', {}, env);
        expect(res.status).toBe(404);
    });

    it('GET /:id/transcript 404s for invisible assets (draft story / orphan)', async () => {
        expect((await app.request('/14/transcript', {}, env)).status).toBe(404);
        expect((await app.request('/15/transcript', {}, env)).status).toBe(404);
        expect((await app.request('/999/transcript', {}, env)).status).toBe(404);
    });

    it('GET /:id/transcript 400s on invalid id', async () => {
        expect((await app.request('/abc/transcript', {}, env)).status).toBe(400);
    });
});
