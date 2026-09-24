import { describe, it, expect } from 'bun:test';
import {
    buildDirectUploadKey,
    isR2DirectKind,
    presignR2PutUrl,
    R2DirectNotConfiguredError,
    R2_DIRECT_MAX_BYTES,
    resolveR2DirectConfig,
    sanitizeDirectFilename,
    validateDirectUploadRequest,
} from '../r2-direct';

const baseEnv = {
    S3_ENDPOINT: 'https://test-account.r2.cloudflarestorage.com',
    S3_BUCKET: 'test-bucket',
    S3_ACCESS_KEY_ID: 'test-key-id',
    S3_SECRET_ACCESS_KEY: 'test-secret',
    S3_FORCE_PATH_STYLE: 'false',
} as unknown as Env;

describe('validateDirectUploadRequest', () => {
    it('accepts a video within the 5GB limit', () => {
        const result = validateDirectUploadRequest({
            kind: 'video',
            mimeType: 'video/mp4',
            size: 4 * 1024 * 1024 * 1024,
        });
        expect(result.ok).toBe(true);
    });

    it('accepts audio and image kinds', () => {
        expect(validateDirectUploadRequest({ kind: 'audio', mimeType: 'audio/mpeg', size: 100 }).ok).toBe(true);
        expect(validateDirectUploadRequest({ kind: 'image', mimeType: 'image/png', size: 100 }).ok).toBe(true);
    });

    it('rejects unknown kind', () => {
        const result = validateDirectUploadRequest({ kind: 'gallery', mimeType: 'image/png', size: 100 });
        expect(result.ok).toBe(false);
        expect(result.code).toBe('direct_file_required');
    });

    it('rejects mismatched mime', () => {
        const result = validateDirectUploadRequest({ kind: 'video', mimeType: 'audio/mpeg', size: 100 });
        expect(result.ok).toBe(false);
        expect(result.code).toBe('direct_invalid_mime');
    });

    it('rejects non-positive size', () => {
        for (const size of [0, -5, Number.NaN, '100']) {
            const result = validateDirectUploadRequest({ kind: 'video', mimeType: 'video/mp4', size });
            expect(result.ok).toBe(false);
            expect(result.code).toBe('direct_invalid_size');
        }
    });

    it('rejects oversize with direct_too_large', () => {
        const over = validateDirectUploadRequest({
            kind: 'image',
            mimeType: 'image/png',
            size: R2_DIRECT_MAX_BYTES.image + 1,
        });
        expect(over.ok).toBe(false);
        expect(over.code).toBe('direct_too_large');

        const videoOver = validateDirectUploadRequest({
            kind: 'video',
            mimeType: 'video/mp4',
            size: R2_DIRECT_MAX_BYTES.video + 1,
        });
        expect(videoOver.ok).toBe(false);
        expect(videoOver.code).toBe('direct_too_large');
    });
});

describe('isR2DirectKind', () => {
    it('matches image/video/audio only', () => {
        expect(isR2DirectKind('image')).toBe(true);
        expect(isR2DirectKind('video')).toBe(true);
        expect(isR2DirectKind('audio')).toBe(true);
        expect(isR2DirectKind('attachment')).toBe(false);
        expect(isR2DirectKind(undefined)).toBe(false);
    });
});

describe('sanitizeDirectFilename', () => {
    it('strips path segments and unsafe chars', () => {
        expect(sanitizeDirectFilename('../../etc/passwd')).toBe('passwd');
        expect(sanitizeDirectFilename('my video (1).mp4')).toBe('my_video_1_.mp4');
    });

    it('falls back to "file" for empty input', () => {
        expect(sanitizeDirectFilename('')).toBe('file');
        expect(sanitizeDirectFilename(undefined)).toBe('file');
        expect(sanitizeDirectFilename('...')).toBe('file');
    });
});

describe('buildDirectUploadKey', () => {
    it('builds media/original/{assetId}/{safeFilename}', () => {
        expect(buildDirectUploadKey(42, 'a b.mp4')).toBe('media/original/42/a_b.mp4');
    });
});

describe('resolveR2DirectConfig', () => {
    it('returns credentials when configured', () => {
        const config = resolveR2DirectConfig(baseEnv);
        expect(config.accessKeyId).toBe('test-key-id');
    });

    it('throws R2DirectNotConfiguredError when credentials are missing', () => {
        const env = { ...baseEnv, S3_ACCESS_KEY_ID: '' } as unknown as Env;
        expect(() => resolveR2DirectConfig(env)).toThrow(R2DirectNotConfiguredError);
        try {
            resolveR2DirectConfig(env);
        } catch (error) {
            expect((error as R2DirectNotConfiguredError).code).toBe('r2_direct_upload_not_configured');
        }
    });
});

describe('presignR2PutUrl', () => {
    it('produces a signed PUT URL with query-string auth', async () => {
        const url = await presignR2PutUrl(baseEnv, 'media/original/7/clip.mp4', 900);
        const parsed = new URL(url);
        // virtual-hosted style: https://{bucket}.{endpoint-host}/{key}
        expect(parsed.hostname).toBe('test-bucket.test-account.r2.cloudflarestorage.com');
        expect(parsed.pathname).toBe('/media/original/7/clip.mp4');
        expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
        expect(parsed.searchParams.get('X-Amz-Expires')).toBe('900');
        expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
        expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    });

    it('respects S3_FORCE_PATH_STYLE=true', async () => {
        const env = { ...baseEnv, S3_FORCE_PATH_STYLE: 'true' } as unknown as Env;
        const url = await presignR2PutUrl(env, 'media/original/7/clip.mp4');
        const parsed = new URL(url);
        expect(parsed.hostname).toBe('test-account.r2.cloudflarestorage.com');
        expect(parsed.pathname).toBe('/test-bucket/media/original/7/clip.mp4');
        expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('throws when not configured', async () => {
        const env = { ...baseEnv, S3_SECRET_ACCESS_KEY: '' } as unknown as Env;
        await expect(presignR2PutUrl(env, 'media/original/7/clip.mp4')).rejects.toThrow(
            R2DirectNotConfiguredError,
        );
    });
});
