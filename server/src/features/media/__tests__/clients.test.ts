import { describe, it, expect } from 'bun:test';
import {
    CloudflareStreamClient,
    mapStreamState,
    computeStreamSync,
    resolveStreamConfig,
} from '../stream';
import {
    CloudflareImagesClient,
    buildVariantsRecord,
    variantNameFromUrl,
    resolveImagesConfig,
} from '../images';
import { CloudflareApiError, MediaNotConfiguredError } from '../client';

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function cfSuccess(result: unknown) {
    return jsonResponse(200, { success: true, errors: [], messages: [], result });
}

function cfError(status: number, code: number, message: string) {
    return jsonResponse(status, { success: false, errors: [{ code, message }], messages: [], result: null });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
    return (async (url: unknown, init?: unknown) => handler(String(url), init as RequestInit)) as typeof fetch;
}

const BASE_ENV = {
    CLOUDFLARE_ACCOUNT_ID: 'acct123',
    CF_MEDIA_API_TOKEN: 'tok_media',
} as unknown as Env;

describe('CloudflareStreamClient', () => {
    it('createDirectUpload posts to direct_upload and returns uid/uploadURL', async () => {
        const seen: Array<{ url: string; init?: RequestInit }> = [];
        const client = new CloudflareStreamClient({
            accountId: 'acct123',
            token: 'tok',
            fetchImpl: mockFetch(async (url, init) => {
                seen.push({ url, init });
                return cfSuccess({ uid: 'vid_1', uploadURL: 'https://upload.videodelivery.net/abc' });
            }),
        });

        const result = await client.createDirectUpload({ maxDurationSeconds: 600, meta: { name: 'a.mp4' } });
        expect(result).toEqual({ uid: 'vid_1', uploadURL: 'https://upload.videodelivery.net/abc' });
        expect(seen).toHaveLength(1);
        expect(seen[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/stream/direct_upload');
        expect((seen[0]!.init!.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
        const body = JSON.parse(String(seen[0]!.init!.body));
        expect(body.maxDurationSeconds).toBe(600);
        expect(body.meta).toEqual({ name: 'a.mp4' });
    });

    it('maps 403 (no permission) to CloudflareApiError with hint', async () => {
        const client = new CloudflareStreamClient({
            accountId: 'acct123',
            token: 'tok',
            fetchImpl: mockFetch(async () => cfError(403, 10000, 'Authentication error')),
        });
        try {
            await client.getVideo('vid_1');
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(CloudflareApiError);
            const apiError = error as CloudflareApiError;
            expect(apiError.status).toBe(403);
            expect(apiError.message).toContain('权限');
        }
    });

    it('maps network failure to CloudflareApiError (no raw throw)', async () => {
        const client = new CloudflareStreamClient({
            accountId: 'acct123',
            token: 'tok',
            fetchImpl: mockFetch(async () => { throw new Error('fetch failed'); }),
        });
        const error = await client.deleteVideo('vid_1').catch((e) => e);
        expect(error).toBeInstanceOf(CloudflareApiError);
        expect((error as CloudflareApiError).status).toBe(0);
    });

    it('rejects malformed direct_upload result', async () => {
        const client = new CloudflareStreamClient({
            accountId: 'acct123',
            token: 'tok',
            fetchImpl: mockFetch(async () => cfSuccess({ uid: 'vid_1' })),
        });
        await expect(client.createDirectUpload()).rejects.toThrow(/malformed/);
    });

    it('getVideo returns video details', async () => {
        const client = new CloudflareStreamClient({
            accountId: 'acct123',
            token: 'tok',
            fetchImpl: mockFetch(async (url) => {
                expect(url).toContain('/stream/vid_9');
                return cfSuccess({ uid: 'vid_9', status: { state: 'ready' }, duration: 12.5, readyToStream: true });
            }),
        });
        const video = await client.getVideo('vid_9');
        expect(video.uid).toBe('vid_9');
        expect(video.status?.state).toBe('ready');
    });
});

describe('resolveStreamConfig', () => {
    it('throws stream_not_configured when account id is missing', () => {
        const error = (() => { try { resolveStreamConfig({} as Env); } catch (e) { return e; } })();
        expect(error).toBeInstanceOf(MediaNotConfiguredError);
        expect((error as MediaNotConfiguredError).code).toBe('stream_not_configured');
    });

    it('throws stream_not_configured when token is missing', () => {
        const error = (() => { try { resolveStreamConfig({ CLOUDFLARE_ACCOUNT_ID: 'a' } as unknown as Env); } catch (e) { return e; } })();
        expect((error as MediaNotConfiguredError).code).toBe('stream_not_configured');
    });

    it('prefers CF_MEDIA_API_TOKEN over CF_STREAM_TOKEN', () => {
        const config = resolveStreamConfig({
            CLOUDFLARE_ACCOUNT_ID: 'a',
            CF_MEDIA_API_TOKEN: 'media',
            CF_STREAM_TOKEN: 'stream',
        } as unknown as Env);
        expect(config.token).toBe('media');
        const fallback = resolveStreamConfig({ CLOUDFLARE_ACCOUNT_ID: 'a', CF_STREAM_TOKEN: 'stream' } as unknown as Env);
        expect(fallback.token).toBe('stream');
    });

    it('resolves from env (smoke)', () => {
        expect(resolveStreamConfig(BASE_ENV).accountId).toBe('acct123');
    });
});

describe('resolveImagesConfig', () => {
    it('throws images_not_configured when token is missing', () => {
        const error = (() => { try { resolveImagesConfig({ CLOUDFLARE_ACCOUNT_ID: 'a' } as unknown as Env); } catch (e) { return e; } })();
        expect((error as MediaNotConfiguredError).code).toBe('images_not_configured');
    });

    it('prefers CF_MEDIA_API_TOKEN over CF_IMAGES_TOKEN', () => {
        const config = resolveImagesConfig({
            CLOUDFLARE_ACCOUNT_ID: 'a',
            CF_MEDIA_API_TOKEN: 'media',
            CF_IMAGES_TOKEN: 'images',
        } as unknown as Env);
        expect(config.token).toBe('media');
    });
});

describe('CloudflareImagesClient', () => {
    it('createDirectUpload posts to images direct_upload', async () => {
        const client = new CloudflareImagesClient({
            accountId: 'acct123',
            token: 'tok',
            fetchImpl: mockFetch(async (url) => {
                expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/images/v2/direct_upload');
                return cfSuccess({ id: 'img_1', uploadURL: 'https://upload.imagedelivery.net/xyz' });
            }),
        });
        const result = await client.createDirectUpload();
        expect(result).toEqual({ id: 'img_1', uploadURL: 'https://upload.imagedelivery.net/xyz' });
    });

    it('getImage returns variants array', async () => {
        const client = new CloudflareImagesClient({
            accountId: 'acct123',
            token: 'tok',
            fetchImpl: mockFetch(async () => cfSuccess({
                id: 'img_1',
                variants: [
                    'https://imagedelivery.net/hash/img_1/public',
                    'https://imagedelivery.net/hash/img_1/thumb',
                ],
            })),
        });
        const image = await client.getImage('img_1');
        expect(image.variants).toHaveLength(2);
    });
});

describe('variant helpers', () => {
    it('variantNameFromUrl takes the last path segment', () => {
        expect(variantNameFromUrl('https://imagedelivery.net/h/id/public')).toBe('public');
        expect(variantNameFromUrl('https://imagedelivery.net/h/id/thumb?w=100')).toBe('thumb');
    });

    it('buildVariantsRecord maps names to full urls', () => {
        const record = buildVariantsRecord([
            'https://imagedelivery.net/h/id/public',
            'https://imagedelivery.net/h/id/medium',
        ]);
        expect(record).toEqual({
            public: 'https://imagedelivery.net/h/id/public',
            medium: 'https://imagedelivery.net/h/id/medium',
        });
        expect(buildVariantsRecord(null)).toEqual({});
        expect(buildVariantsRecord(['not-a-url'])).toEqual({ 'not-a-url': 'not-a-url' });
    });
});

describe('mapStreamState', () => {
    it('maps Stream states to db statuses', () => {
        expect(mapStreamState('pendingupload')).toBe('uploading');
        expect(mapStreamState('downloading')).toBe('processing');
        expect(mapStreamState('queued')).toBe('processing');
        expect(mapStreamState('inprogress')).toBe('processing');
        expect(mapStreamState('ready')).toBe('ready');
        expect(mapStreamState('error')).toBe('error');
        expect(mapStreamState('bogus')).toBeNull();
        expect(mapStreamState(null)).toBeNull();
    });
});

describe('computeStreamSync', () => {
    const input = {
        state: 'ready',
        errorReasonCode: null,
        errorReasonText: null,
        duration: 100.6,
        thumbnail: 'https://videodelivery.net/u/thumbnails/thumbnail.jpg',
        readyToStream: true,
        pctComplete: '100.000000',
    };

    it('dedupes when target equals current (idempotent)', () => {
        const decision = computeStreamSync('ready', '{}', input);
        expect(decision.changed).toBe(false);
        if (!decision.changed) expect(decision.reason).toBe('deduped');
    });

    it('advances uploading -> processing and merges meta', () => {
        const decision = computeStreamSync('uploading', '{"keep":"me"}', { ...input, state: 'inprogress' });
        expect(decision.changed).toBe(true);
        if (decision.changed) {
            expect(decision.target).toBe('processing');
            expect(decision.patch.streamStatus).toBe('processing');
            expect(decision.patch.streamError).toBe('');
            expect(decision.patch.duration).toBe(101);
            const meta = JSON.parse(decision.patch.streamMetaJson);
            expect(meta.keep).toBe('me');
            expect(meta.readyToStream).toBe(true);
            expect(meta.lastSyncAt).toBeTruthy();
        }
    });

    it('sets stream_error on error state', () => {
        const decision = computeStreamSync('processing', '{}', {
            ...input, state: 'error', errorReasonCode: 'ERR', errorReasonText: 'bad video',
        });
        expect(decision.changed).toBe(true);
        if (decision.changed) {
            expect(decision.target).toBe('error');
            expect(decision.patch.streamError).toBe('bad video');
        }
    });

    it('rejects stale transitions (ready -> processing)', () => {
        const decision = computeStreamSync('ready', '{}', { ...input, state: 'inprogress' });
        expect(decision.changed).toBe(false);
        if (!decision.changed) expect(decision.reason).toBe('stale');
    });

    it('reports unknown_state for unrecognized states', () => {
        const decision = computeStreamSync('uploading', '{}', { ...input, state: 'weird' });
        expect(decision.changed).toBe(false);
        if (!decision.changed) expect(decision.reason).toBe('unknown_state');
    });

    it('treats missing/unknown current status as ready', () => {
        const decision = computeStreamSync(null, '{}', input);
        expect(decision.changed).toBe(false);
    });
});
