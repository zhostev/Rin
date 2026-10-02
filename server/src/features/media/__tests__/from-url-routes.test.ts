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

    it('plain Instagram post URL imports the whole carousel by default (201)', async () => {
        await setup({ R2_BUCKET: r2Mock(), APIFY_TOKEN: 'apify_api_test' });
        const cdnUrl =
            'https://scontent-lax3-2.cdninstagram.com/v/t51.82787-15/819629641_18069542963758159_8941759054600826811_n.jpg?stp=dst-jpg_e35_tt6';
        mockFetchImpl((url) => {
            if (url.includes('api.apify.com')) {
                return new Response(
                    JSON.stringify([
                        {
                            shortCode: 'DdqNdIPmjpa',
                            type: 'Sidecar',
                            childPosts: [
                                { type: 'Image', displayUrl: cdnUrl },
                                {
                                    type: 'Video',
                                    displayUrl: 'https://scontent-lax3-2.cdninstagram.com/clip.mp4',
                                },
                            ],
                        },
                    ]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                );
            }
            return pngResponse();
        });

        const res = await postFromUrl({
            url: 'https://www.instagram.com/p/DdqNdIPmjpa/?stkn=MTE0bjlpd3k4dXR4Zw==',
            title: 'Kumamoto',
        });
        expect(res.status).toBe(201);
        const data = await res.json() as any;
        // 缺省即批量：响应为 { assets, warnings }，视频跳过要如实回报
        expect(Array.isArray(data.assets)).toBe(true);
        expect(data.assets).toHaveLength(1);
        expect(data.assets[0].kind).toBe('image');
        expect(data.assets[0].mime).toBe('image/png');
        expect(data.assets[0].title).toBe('Kumamoto');
        expect(puts.length).toBe(1);
        expect(puts[0]).toMatch(/_n\.jpg$/);
        expect(data.warnings).toHaveLength(1);
        expect(data.warnings[0]).toContain('1 个视频');
    });

    it('?img_index=all imports every carousel image as its own asset (201)', async () => {
        await setup({ R2_BUCKET: r2Mock(), APIFY_TOKEN: 'apify_api_test' });
        const cdn = (n: number) =>
            `https://scontent-lax3-2.cdninstagram.com/v/t51.82787-15/81962964${n}_n.jpg`;
        mockFetchImpl((url) => {
            if (url.includes('api.apify.com')) {
                return new Response(
                    JSON.stringify([
                        {
                            shortCode: 'Dd6OBf1lAy5',
                            type: 'Sidecar',
                            childPosts: [
                                { type: 'Image', displayUrl: cdn(1) },
                                { type: 'Video', displayUrl: 'https://scontent-lax3-2.cdninstagram.com/clip.mp4' },
                                { type: 'Image', displayUrl: cdn(2) },
                                { type: 'Image', displayUrl: cdn(3) },
                            ],
                        },
                    ]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                );
            }
            return pngResponse();
        });

        const res = await postFromUrl({
            url: 'https://www.instagram.com/p/Dd6OBf1lAy5/?img_index=all',
            title: 'Carousel',
        });
        expect(res.status).toBe(201);
        const data = await res.json() as any;
        expect(Array.isArray(data.assets)).toBe(true);
        expect(data.assets).toHaveLength(3);
        expect(data.assets.every((a: any) => a.kind === 'image')).toBe(true);
        expect(puts).toHaveLength(3);
        // 批量标题带序号后缀
        expect(data.assets[0].title).toBe('Carousel (1/3)');
        expect(data.assets[2].title).toBe('Carousel (3/3)');
        // 跳过的视频要如实回报，不能悄悄少几张
        expect(data.warnings).toHaveLength(1);
        expect(data.warnings[0]).toContain('1 个视频');
    });

    it('?img_index=all 没有标题时用短码当标题基名（便于回溯来源）', async () => {
        await setup({ R2_BUCKET: r2Mock(), APIFY_TOKEN: 'apify_api_test' });
        const cdn = (n: number) =>
            `https://scontent-lax3-2.cdninstagram.com/v/t51.82787-15/81962964${n}_n.jpg`;
        mockFetchImpl((url) => {
            if (url.includes('api.apify.com')) {
                return new Response(
                    JSON.stringify([
                        {
                            shortCode: 'Dd6OBf1lAy5',
                            type: 'Sidecar',
                            childPosts: [
                                { type: 'Image', displayUrl: cdn(1) },
                                { type: 'Image', displayUrl: cdn(2) },
                            ],
                        },
                    ]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                );
            }
            return pngResponse();
        });

        const res = await postFromUrl({ url: 'https://www.instagram.com/p/Dd6OBf1lAy5/?img_index=all' });
        expect(res.status).toBe(201);
        const data = await res.json() as any;
        expect(data.assets.map((a: any) => a.title)).toEqual([
            'Instagram Dd6OBf1lAy5 (1/2)',
            'Instagram Dd6OBf1lAy5 (2/2)',
        ]);
    });

    it('?img_index=all 某张失败不改整体：已入库的照常返回 201 + warnings（不报 5xx）', async () => {
        await setup({ R2_BUCKET: r2Mock(), APIFY_TOKEN: 'apify_api_test' });
        const cdn = (n: number) =>
            `https://scontent-lax3-2.cdninstagram.com/v/t51.82787-15/81962964${n}_n.jpg`;
        mockFetchImpl((url) => {
            if (url.includes('api.apify.com')) {
                return new Response(
                    JSON.stringify([
                        {
                            shortCode: 'Dd6OBf1lAy5',
                            type: 'Sidecar',
                            childPosts: [
                                { type: 'Image', displayUrl: cdn(1) },
                                { type: 'Image', displayUrl: cdn(2) },
                                { type: 'Image', displayUrl: cdn(3) },
                            ],
                        },
                    ]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                );
            }
            return url.includes('819629642') ? new Response('gone', { status: 404 }) : pngResponse();
        });

        const res = await postFromUrl({
            url: 'https://www.instagram.com/p/Dd6OBf1lAy5/?img_index=all',
            title: 'Carousel',
        });
        expect(res.status).toBe(201);
        const data = await res.json() as any;
        expect(data.assets).toHaveLength(2);
        expect(data.assets.map((a: any) => a.title)).toEqual(['Carousel (1/3)', 'Carousel (3/3)']);
        expect(puts).toHaveLength(2);
        expect(data.warnings).toHaveLength(1);
        expect(data.warnings[0]).toContain('第 2/3 张下载失败');
    });

    it('?img_index=all 一张都没成功时按错误码返回（不假装 201）', async () => {
        await setup({ R2_BUCKET: r2Mock(), APIFY_TOKEN: 'apify_api_test' });
        mockFetchImpl((url) => {
            if (url.includes('api.apify.com')) {
                return new Response(
                    JSON.stringify([
                        {
                            shortCode: 'Dd6OBf1lAy5',
                            type: 'Sidecar',
                            childPosts: [
                                { type: 'Image', displayUrl: 'https://scontent-lax3-2.cdninstagram.com/a.jpg' },
                                { type: 'Image', displayUrl: 'https://scontent-lax3-2.cdninstagram.com/b.jpg' },
                            ],
                        },
                    ]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                );
            }
            return new Response('nope', { status: 500 });
        });

        const res = await postFromUrl({ url: 'https://www.instagram.com/p/Dd6OBf1lAy5/?img_index=all' });
        expect(res.status).toBe(502);
        const data = await res.json() as any;
        expect(data.error.code).toBe('download_failed');
        expect(puts).toHaveLength(0);
    });

    it('?img_index=all 下载并发受控（2–3 张同时在飞，不串行也不打满）', async () => {
        await setup({ R2_BUCKET: r2Mock(), APIFY_TOKEN: 'apify_api_test' });
        const cdn = (n: number) =>
            `https://scontent-lax3-2.cdninstagram.com/v/t51.82787-15/81962964${n}_n.jpg`;
        let inFlight = 0;
        let maxInFlight = 0;
        mockFetchImpl(async (url) => {
            if (url.includes('api.apify.com')) {
                return new Response(
                    JSON.stringify([
                        {
                            shortCode: 'Dd6OBf1lAy5',
                            type: 'Sidecar',
                            childPosts: Array.from({ length: 6 }, (_, i) => ({
                                type: 'Image',
                                displayUrl: cdn(i + 1),
                            })),
                        },
                    ]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                );
            }
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            return pngResponse();
        });

        const res = await postFromUrl({ url: 'https://www.instagram.com/p/Dd6OBf1lAy5/?img_index=all' });
        expect(res.status).toBe(201);
        const data = await res.json() as any;
        expect(data.assets).toHaveLength(6);
        expect(maxInFlight).toBe(3);
    });

    it('422 instagram_resolve_failed when Apify has nothing for the post', async () => {
        await setup({ R2_BUCKET: r2Mock(), APIFY_TOKEN: 'apify_api_test' });
        mockFetchImpl(() =>
            new Response(JSON.stringify([]), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const res = await postFromUrl({ url: 'https://www.instagram.com/p/DdqNdIPmjpa/' });
        expect(res.status).toBe(422);
        const data = await res.json() as any;
        expect(data.error.code).toBe('instagram_resolve_failed');
        expect(puts.length).toBe(0);
    });

    it('422 with a config hint when APIFY_TOKEN is not set', async () => {
        await setup({ R2_BUCKET: r2Mock() });
        mockFetchImpl(() => pngResponse());
        const res = await postFromUrl({ url: 'https://www.instagram.com/p/DdqNdIPmjpa/' });
        expect(res.status).toBe(422);
        const data = await res.json() as any;
        expect(data.error.code).toBe('instagram_resolve_failed');
        expect(data.error.message).toContain('APIFY_TOKEN');
        expect(puts.length).toBe(0);
    });

    it('422 instagram_resolve_failed when Apify rejects the call', async () => {
        await setup({ R2_BUCKET: r2Mock(), APIFY_TOKEN: 'apify_api_test' });
        mockFetchImpl(() => new Response('not found', { status: 404 }));
        const res = await postFromUrl({ url: 'https://www.instagram.com/p/DdqNdIPmjpa/' });
        expect(res.status).toBe(422);
        const data = await res.json() as any;
        expect(data.error.code).toBe('instagram_resolve_failed');
        expect(data.error.upstreamStatus).toBe(404);
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
