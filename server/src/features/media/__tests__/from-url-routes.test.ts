import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from "hono";
import type { Variables } from "../../../core/hono-types";
import { setupTestApp, createTestUser, cleanupTestDB } from '../../../../tests/fixtures';
import { applyMediaMigration } from '../../../../tests/fixtures/media';
import { AdminMediaService } from '../../../services/media';
import type { Database } from 'bun:sqlite';

const ADMIN_HEADERS = {
    'Authorization': 'Bearer mock_token_1',
    'Content-Type': 'application/json',
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function pngResponse(): Response {
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
}

describe('AdminMediaService POST /from-url', () => {
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

    function postFromUrl(body: unknown) {
        return app.request('/from-url', {
            method: 'POST',
            headers: ADMIN_HEADERS,
            body: JSON.stringify(body),
        }, env);
    }

    it('rejects non-admin callers with 401', async () => {
        await setup({ R2_BUCKET: r2Mock() });
        const res = await app.request('/from-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://example.com/a.png' }),
        }, env);
        expect(res.status).toBe(401);
    });

    it('downloads the image into R2 and returns the asset (201)', async () => {
        await setup({ R2_BUCKET: r2Mock() });
        mockFetchImpl(() => pngResponse());

        const res = await postFromUrl({
            url: 'https://example.com/photos/sunset.png',
            title: 'Sunset',
            alt: 'a sunset',
        });
        expect(res.status).toBe(201);
        const data = await res.json() as any;
        expect(data.kind).toBe('image');
        expect(data.mime).toBe('image/png');
        expect(data.title).toBe('Sunset');
        expect(data.url).toContain('/api/blob/');
        expect(puts.length).toBe(1);
        expect(puts[0]).toMatch(/^media\/original\/\d+\/sunset\.png$/);
    });

    it('400 invalid_url on non-http URL', async () => {
        await setup({ R2_BUCKET: r2Mock() });
        const res = await postFromUrl({ url: 'ftp://example.com/a.png' });
        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.error.code).toBe('invalid_url');
    });

    it('400 url_not_allowed on private host', async () => {
        await setup({ R2_BUCKET: r2Mock() });
        const res = await postFromUrl({ url: 'http://169.254.169.254/latest/meta-data/' });
        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.error.code).toBe('url_not_allowed');
        expect(puts.length).toBe(0);
    });

    it('502 download_failed when upstream 404s', async () => {
        await setup({ R2_BUCKET: r2Mock() });
        mockFetchImpl(() => new Response('nope', { status: 404 }));
        const res = await postFromUrl({ url: 'https://example.com/missing.png' });
        expect(res.status).toBe(502);
        const data = await res.json() as any;
        expect(data.error.code).toBe('download_failed');
        expect(data.error.upstreamStatus).toBe(404);
        expect(puts.length).toBe(0);
    });

    it('415 not_an_image when the URL serves HTML', async () => {
        await setup({ R2_BUCKET: r2Mock() });
        mockFetchImpl(() => new Response('<html>login</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        }));
        const res = await postFromUrl({ url: 'https://example.com/page' });
        expect(res.status).toBe(415);
        const data = await res.json() as any;
        expect(data.error.code).toBe('not_an_image');
        expect(puts.length).toBe(0);
    });

    it('413 image_too_large when content-length exceeds the limit', async () => {
        await setup({ R2_BUCKET: r2Mock() });
        mockFetchImpl(() => new Response(PNG, {
            status: 200,
            headers: { 'content-type': 'image/png', 'content-length': String(50 * 1024 * 1024) },
        }));
        const res = await postFromUrl({ url: 'https://example.com/huge.png' });
        expect(res.status).toBe(413);
        const data = await res.json() as any;
        expect(data.error.code).toBe('image_too_large');
        expect(puts.length).toBe(0);
    });

    it('503 storage_not_configured without R2 or S3', async () => {
        await setup({
            S3_ENDPOINT: '',
            S3_ACCESS_KEY_ID: '',
            S3_SECRET_ACCESS_KEY: '',
            S3_BUCKET: '',
        } as unknown as Partial<Env>);
        const res = await postFromUrl({ url: 'https://example.com/a.png' });
        expect(res.status).toBe(503);
        const data = await res.json() as any;
        expect(data.error.code).toBe('storage_not_configured');
    });

    it('no orphan asset row when R2 put fails', async () => {
        await setup({
            R2_BUCKET: {
                put: async () => { throw new Error('r2 down'); },
                delete: async () => {},
            } as unknown as R2Bucket,
        });
        mockFetchImpl(() => pngResponse());
        const res = await postFromUrl({ url: 'https://example.com/a.png' });
        expect(res.status).toBe(502);
        const data = await res.json() as any;
        expect(data.error.code).toBe('image_download_store_failed');

        const list = await app.request('/?kind=image', { headers: ADMIN_HEADERS }, env);
        const listData = await list.json() as any;
        expect(listData.size).toBe(0);
    });
});
