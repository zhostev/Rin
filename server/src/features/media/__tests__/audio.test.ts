import { describe, it, expect } from 'bun:test';
import { sanitizeFilename, buildAudioKey, uploadAudioObject } from '../audio';

describe('sanitizeFilename', () => {
    it('strips directories (path traversal)', () => {
        expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
        expect(sanitizeFilename('C:\\music\\song.mp3')).toBe('song.mp3');
    });

    it('replaces unsafe characters', () => {
        expect(sanitizeFilename('my song (final).mp3')).toBe('my_song_final_.mp3');
    });

    it('falls back to "audio" for empty names', () => {
        expect(sanitizeFilename('')).toBe('audio');
        expect(sanitizeFilename(null)).toBe('audio');
        expect(sanitizeFilename('...')).toBe('audio');
    });

    it('truncates long names', () => {
        expect(sanitizeFilename('a'.repeat(200) + '.mp3')).toHaveLength(120);
    });
});

describe('buildAudioKey', () => {
    it('follows the media/original/{assetId}/{safeFilename} convention', () => {
        expect(buildAudioKey(42, 'song.mp3')).toBe('media/original/42/song.mp3');
    });
});

describe('uploadAudioObject', () => {
    it('puts to the R2 binding and returns a /api/blob url', async () => {
        const puts: Array<{ key: string; contentType?: string }> = [];
        const env = {
            R2_BUCKET: {
                put: async (key: string, _body: unknown, opts?: { httpMetadata?: { contentType?: string } }) => {
                    puts.push({ key, contentType: opts?.httpMetadata?.contentType });
                    return null;
                },
            },
        } as unknown as Env;

        const file = new File(['audio-bytes'], 'song.mp3', { type: 'audio/mpeg' });
        const result = await uploadAudioObject(env, 7, file, file.name, file.type);

        expect(result.key).toBe('media/original/7/song.mp3');
        expect(result.url).toBe('/api/blob/media/original/7/song.mp3');
        expect(result.usedR2Binding).toBe(true);
        expect(puts).toHaveLength(1);
        expect(puts[0]!.contentType).toBe('audio/mpeg');
    });

    it('throws when neither R2 binding nor S3 is configured (router maps to 503)', async () => {
        const env = {} as Env;
        const file = new File(['x'], 'a.mp3', { type: 'audio/mpeg' });
        await expect(uploadAudioObject(env, 1, file, 'a.mp3')).rejects.toThrow(/S3_ENDPOINT/);
    });
});
