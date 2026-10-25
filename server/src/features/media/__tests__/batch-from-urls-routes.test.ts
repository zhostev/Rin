import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from "hono";
import type { Variables } from "../../../core/hono-types";
import { setupTestApp, createTestUser, cleanupTestDB } from '../../../../tests/fixtures';
import { applyMediaMigration } from '../../../../tests/fixtures/media';
import { AdminMediaService, sanitizeGroupKey, BATCH_FROM_URLS_MAX_ITEMS } from '../../../services/media';
import type { Database } from 'bun:sqlite';

const ADMIN_HEADERS = {
    'Authorization': 'Bearer mock_token_1',
    'Content-Type': 'application/json',
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function pngResponse(): Response {
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
}

describe('AdminMediaService POST /batch-from-urls', () => {
    let app: Hono<{ Bindings: Env; Variables: Variables }>;
    let sqlite: Database;
    let env: Env;
    let realFetch: typeof fetch;
    let puts: string[];

    function r2Mock() {
        return {
            put: async (key: string) => {
                puts.push(key);
                return null;
            },
            delete: async () => {},
        } as unknown as R2Bucket;
    }

    async function setup(envOverrides: Partial<Env> = {}) {
        const ctx = await setupTestApp(() => AdminMediaService(), envOverrides);
        applyMediaMigration(ctx.sqlite);
        await createTestUser(ctx.sqlite);
        app = ctx.app; sqlite = ctx.sqlite; env = ctx.env;
    }

    beforeEach(() => {
        realFetch = globalThis.fetch;
        puts = [];
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
        if (sqlite) cleanupTestDB(sqlite);
    });

    function mockFetchImpl(handler: (url: string) => Response | Promise<Response>) {
        globalThis.fetch = (async (url: unknown) =>
            handler(String(url))) as typeof fetch;
    }

    function postBatch(body: unknown) {
        return app.request('/batch-from-urls', {
            method: 'POST',
            headers: ADMIN_HEADERS,
            body: JSON.stringify(body),
        }, env);
    }

    it('rejects non-admin callers with 401', async () => {
        await setup({ R2_BUCKET: r2Mock() });
        const res = await app.request('/batch-from-urls', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: [{ url: 'https://example.com/a.png' }] }),
        }, env);
        expect(res.status).toBe(401);
    });

    it('400 batch_too_large when more than 20 items', async () => {
        await setup({ R2_BUCKET: r2Mock() });
        expect(BATCH_FROM_URLS_MAX_ITEMS).toBe(20);
        const items = Array.from({ length: 21 }, (_, i) => ({ url: `https://example.com/${i}.png` }));
        const res = await postBatch({ items });
        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.error.code).toBe('batch_too_large');
    });

    it('400 items_required on empty items', async () => {
        await setup({ R2_BUCKET: r2Mock() });
        const res = await postBatch({ items: [] });
        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.error.code).toBe('items_required');
    });

    it('201 partial success: one failure does not affect the others, groupKey shared', async () => {
        await setup({ R2_BUCKET: r2Mock() });
        mockFetchImpl((url) =>
            url.includes('missing') ? new Response('gone', { status: 404 }) : pngResponse(),
        );
        const res = await postBatch({
            items: [
                { url: 'https://example.com/a.png', title: 'A' },
                { url: 'https://example.com/missing.png', title: 'B' },
                { url: 'https://example.com/c.png', title: 'C' },
            ],
            groupKey: 'batch:test-1',
        });
        expect(res.status).toBe(201);
        const data = await res.json() as any;
        expect(data.assets).toHaveLength(2);
        expect(data.assets.map((a: any) => a.title)).toEqual(['A', 'C']);
        expect(data.assets.every((a: any) => a.group_key === 'batch:test-1')).toBe(true);
        expect(data.failures).toHaveLength(1);
        expect(data.failures[0].index).toBe(1);
        expect(data.failures[0].url).toBe('https://example.com/missing.png');
        expect(data.failures[0].code).toBe('download_failed');
        expect(data.groupKey).toBe('batch:test-1');
        expect(data.warnings).toEqual([]);
        expect(puts).toHaveLength(2);
    });

    it('per-item invalid URL becomes a failure, not a whole-request 400', async () => {
        await setup({ R2_BUCKET: r2Mock() });
        mockFetchImpl(() => pngResponse());
        const res = await postBatch({
            items: [
                { url: 'ftp://example.com/a.png' },
                { url: 'https://example.com/b.png', title: 'B' },
            ],
        });
        expect(res.status).toBe(201);
        const data = await res.json() as any;
        expect(data.assets).toHaveLength(1);
        expect(data.failures).toHaveLength(1);
        expect(data.failures[0].index).toBe(0);
        expect(data.failures[0].code).toBe('invalid_url');
    });

    it('all failed returns the first failure status (502 download_failed)', async () => {
        await setup({ R2_BUCKET: r2Mock() });
        mockFetchImpl(() => new Response('gone', { status: 404 }));
        const res = await postBatch({
            items: [{ url: 'https://example.com/a.png' }, { url: 'https://example.com/b.png' }],
        });
        expect(res.status).toBe(502);
        const data = await res.json() as any;
        expect(data.error.code).toBe('download_failed');
        expect(puts).toHaveLength(0);
    });

    it('all invalid returns 400 invalid_url', async () => {
        await setup({ R2_BUCKET: r2Mock() });
        const res = await postBatch({ items: [{ url: 'not a url' }] });
        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.error.code).toBe('invalid_url');
    });

    it('groupTitle is used as fallback title when an item has no title', async () => {
        await setup({ R2_BUCKET: r2Mock() });
        mockFetchImpl(() => pngResponse());
        const res = await postBatch({
            items: [{ url: 'https://example.com/a.png' }, { url: 'https://example.com/b.png' }],
            groupTitle: '山海骑行',
        });
        expect(res.status).toBe(201);
        const data = await res.json() as any;
        expect(data.assets.map((a: any) => a.title)).toEqual(['山海骑行 (1/2)', '山海骑行 (2/2)']);
        // 只传 groupTitle 不传 groupKey 时服务端不自动造 key
        expect(data.groupKey).toBe('');
        expect(data.assets.every((a: any) => !a.group_key)).toBe(true);
    });

    it('sanitizeGroupKey keeps only alphanumerics, -, _ and :, truncates to 100', () => {
        expect(sanitizeGroupKey('my group!key@2026')).toBe('mygroupkey2026');
        expect(sanitizeGroupKey('batch:test_1-x')).toBe('batch:test_1-x');
        expect(sanitizeGroupKey('a'.repeat(150))).toHaveLength(100);
        expect(sanitizeGroupKey(undefined)).toBe('');
        expect(sanitizeGroupKey(123)).toBe('');
    });

    it('client groupKey with illegal chars is cleaned before storing', async () => {
        await setup({ R2_BUCKET: r2Mock() });
        mockFetchImpl(() => pngResponse());
        const res = await postBatch({
            items: [{ url: 'https://example.com/a.png', title: 'A' }],
            groupKey: 'my group!key',
        });
        expect(res.status).toBe(201);
        const data = await res.json() as any;
        expect(data.groupKey).toBe('mygroupkey');
        expect(data.assets[0].group_key).toBe('mygroupkey');
    });

    it('503 storage_not_configured without R2 or S3', async () => {
        await setup({
            S3_ENDPOINT: '',
            S3_ACCESS_KEY_ID: '',
            S3_SECRET_ACCESS_KEY: '',
            S3_BUCKET: '',
        } as unknown as Partial<Env>);
        const res = await postBatch({ items: [{ url: 'https://example.com/a.png' }] });
        expect(res.status).toBe(503);
        const data = await res.json() as any;
        expect(data.error.code).toBe('storage_not_configured');
    });

    it('POST /r2/direct-upload stores a sanitized groupKey on the new asset', async () => {
        await setup();
        const res = await app.request('/r2/direct-upload', {
            method: 'POST',
            headers: ADMIN_HEADERS,
            body: JSON.stringify({
                kind: 'image',
                filename: 'a.jpg',
                mimeType: 'image/jpeg',
                size: 100,
                title: 'A',
                groupKey: 'my group!key',
            }),
        }, env);
        expect(res.status).toBe(201);
        const data = await res.json() as any;
        expect(data.asset.group_key).toBe('mygroupkey');
    });
});
