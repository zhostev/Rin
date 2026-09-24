import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from "hono";
import type { Database } from 'bun:sqlite';
import type { Variables } from "../../../core/hono-types";
import { setupTestApp, createTestUser, cleanupTestDB } from '../../../../tests/fixtures';
import { applyMediaCenterMigration } from '../../../../tests/fixtures/media-center';
import { SearchService } from '../../../services/feed';

const ADMIN_HEADERS = { 'Authorization': 'Bearer mock_token_1' };

function seed(sqlite: Database) {
    sqlite.exec(`
        INSERT INTO stories (id, slug, title, status, published_at, updated_at) VALUES
            (1, 'pub-story', 'Published Story', 'published', 1717200000, 1717200000),
            (2, 'draft-story', 'Draft Story', 'draft', NULL, 1742000000);

        INSERT INTO media_assets (id, kind, source, title, stream_uid, stream_status, created_at, updated_at) VALUES
            (20, 'video', 'stream', 'Talk', 'uid-20', 'ready', 1742000000, 1742000000),
            (21, 'video', 'stream', 'Draft talk', 'uid-21', 'ready', 1742000000, 1742000000);

        INSERT INTO content_blocks (story_id, type, position, payload_json) VALUES
            (1, 'video', 0, '{"asset_id":20}'),
            (2, 'video', 0, '{"asset_id":21}');
    `);
    const longText = '这是一段很长很长很长很长很长很长很长很长很长很长的转录文本，中间提到量子计算这个关键词，然后还有很长很长很长很长很长很长很长很长很长很长的后续内容。';
    const segments = JSON.stringify([
        { start: 0, end: 12, text: '量子计算入门' },
        { start: 13, end: 25, text: '今天天气不错' },
        { start: 26, end: 40, text: '深入量子纠缠' },
    ]);
    // 用参数化插入避免引号转义问题
    const insert = sqlite.prepare(
        `INSERT INTO transcripts (asset_id, language, text, segments_json, status) VALUES (?, 'zh', ?, ?, 'published')`,
    );
    insert.run(20, longText, segments);
    insert.run(21, '草稿里的量子随笔', '[]');
}

describe('SearchService transcripts extension', () => {
    let app: Hono<{ Bindings: Env; Variables: Variables }>;
    let sqlite: Database;
    let env: Env;

    beforeEach(async () => {
        const ctx = await setupTestApp(() => SearchService());
        applyMediaCenterMigration(ctx.sqlite);
        app = ctx.app;
        sqlite = ctx.sqlite;
        env = ctx.env;
        await createTestUser(sqlite);
        seed(sqlite);
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });

    it('attaches transcript hits with ~40-char snippets and matching segments', async () => {
        const res = await app.request(`/${encodeURIComponent('量子')}`, {}, env);
        expect(res.status).toBe(200);
        const body = await res.json() as any;

        // 原有 shape 不变
        expect(body).toHaveProperty('size');
        expect(body).toHaveProperty('data');
        expect(body).toHaveProperty('hasNext');

        // 公开搜索只命中已发布 story 的转录
        expect(body.transcripts).toHaveLength(1);
        const hit = body.transcripts[0];
        expect(hit).toMatchObject({
            assetId: 20,
            storyId: 1,
            storySlug: 'pub-story',
            storyTitle: 'Published Story',
        });
        expect(hit.snippet).toContain('量子计算');
        expect(hit.snippet.length).toBeLessThanOrEqual(40 * 2 + '量子计算'.length + 2);
        expect(hit.segments).toHaveLength(2);
        expect(hit.segments[0]).toMatchObject({ start: 0, end: 12, text: '量子计算入门' });
        expect(hit.segments[1].text).toBe('深入量子纠缠');
    });

    it('omits the transcripts field when there are no hits', async () => {
        const res = await app.request(`/${encodeURIComponent('不存在的词xyz')}`, {}, env);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect('transcripts' in body).toBe(false);
    });

    it('lets admins see transcripts attached to draft stories', async () => {
        const res = await app.request(`/${encodeURIComponent('量子')}`, { headers: ADMIN_HEADERS }, env);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        const assetIds = body.transcripts.map((h: any) => h.assetId).sort();
        expect(assetIds).toEqual([20, 21]);
    });
});
