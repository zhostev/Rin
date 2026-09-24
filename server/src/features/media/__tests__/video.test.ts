import { describe, it, expect } from 'bun:test';
import {
    buildVideoKey,
    parseProbedNumber,
    sanitizeVideoFilename,
    validateUploadFile,
    VIDEO_MAX_BYTES,
    POSTER_MAX_BYTES,
    SUBTITLES_MAX_BYTES,
} from '../video';
import { serializeMediaAsset } from '../asset';
import type { MediaAssetRow } from '../repository';

function file(name: string, type: string, size: number): File {
    const f = new File(['x'.repeat(Math.min(size, 64))], name, { type });
    // bun 的 File 允许覆盖 size 以模拟大文件（不实际分配内存）
    Object.defineProperty(f, 'size', { value: size });
    return f;
}

describe('validateUploadFile', () => {
    it('accepts video files within the limit', () => {
        expect(validateUploadFile(file('a.mp4', 'video/mp4', 1024), 'video').ok).toBe(true);
    });

    it('rejects missing files', () => {
        const result = validateUploadFile(undefined, 'video');
        expect(result.ok).toBe(false);
        expect(result.code).toBe('video_file_required');
    });

    it('rejects non-video mime for video', () => {
        const result = validateUploadFile(file('a.mp3', 'audio/mpeg', 1024), 'video');
        expect(result.ok).toBe(false);
        expect(result.code).toBe('video_invalid_mime');
    });

    it('rejects oversize video with video_too_large', () => {
        const result = validateUploadFile(file('big.mp4', 'video/mp4', VIDEO_MAX_BYTES + 1), 'video');
        expect(result.ok).toBe(false);
        expect(result.code).toBe('video_too_large');
    });

    it('rejects oversize poster', () => {
        const result = validateUploadFile(file('c.png', 'image/png', POSTER_MAX_BYTES + 1), 'poster');
        expect(result.ok).toBe(false);
        expect(result.code).toBe('video_too_large');
    });

    it('accepts .vtt by extension even when mime is text/plain', () => {
        expect(validateUploadFile(file('cap.vtt', 'text/plain', 128), 'subtitles').ok).toBe(true);
    });

    it('rejects oversize subtitles', () => {
        const result = validateUploadFile(file('cap.vtt', 'text/vtt', SUBTITLES_MAX_BYTES + 1), 'subtitles');
        expect(result.ok).toBe(false);
        expect(result.code).toBe('video_too_large');
    });

    it('rejects non-vtt files for subtitles', () => {
        const result = validateUploadFile(file('cap.srt', 'text/plain', 128), 'subtitles');
        expect(result.ok).toBe(false);
        expect(result.code).toBe('video_invalid_mime');
    });
});

describe('sanitizeVideoFilename / buildVideoKey', () => {
    it('strips path segments and illegal chars', () => {
        expect(sanitizeVideoFilename('../../etc/passwd.mp4')).toBe('passwd.mp4');
        expect(sanitizeVideoFilename('我的 视频 (1).mp4')).toBe('1_.mp4');
    });

    it('falls back to "video" for empty names', () => {
        expect(sanitizeVideoFilename('')).toBe('video');
        expect(sanitizeVideoFilename(undefined)).toBe('video');
    });

    it('builds the canonical R2 key', () => {
        expect(buildVideoKey(42, 'clip.mp4')).toBe('media/original/42/clip.mp4');
    });
});

describe('parseProbedNumber', () => {
    it('parses numeric strings and numbers', () => {
        expect(parseProbedNumber('12.5')).toBe(12.5);
        expect(parseProbedNumber(720)).toBe(720);
    });

    it('ignores invalid values', () => {
        expect(parseProbedNumber('')).toBeUndefined();
        expect(parseProbedNumber('abc')).toBeUndefined();
        expect(parseProbedNumber(-3)).toBeUndefined();
        expect(parseProbedNumber(undefined)).toBeUndefined();
        expect(parseProbedNumber(NaN)).toBeUndefined();
    });
});

function row(partial: Partial<MediaAssetRow>): MediaAssetRow {
    return {
        id: 1,
        kind: 'video',
        source: 'r2',
        r2Key: 'media/original/1/clip.mp4',
        streamUid: null,
        mime: 'video/mp4',
        duration: 12,
        width: 1280,
        height: 720,
        altText: '',
        title: 'Clip',
        streamStatus: 'ready',
        streamError: '',
        streamMetaJson: '{}',
        imagesId: '',
        imagesVariantsJson: '{}',
        uploadSessionJson: '{}',
        posterAssetId: null,
        subtitlesAssetId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...partial,
    } as MediaAssetRow;
}

describe('serializeMediaAsset with linked poster/subtitles', () => {
    it('derives poster_url/subtitles_url from linked rows', () => {
        const poster = row({ id: 2, kind: 'image', r2Key: 'media/original/2/c.png', mime: 'image/png' });
        const subs = row({ id: 3, kind: 'attachment', r2Key: 'media/original/3/c.vtt', mime: 'text/vtt' });
        const video = row({ posterAssetId: 2, subtitlesAssetId: 3 });

        const asset = serializeMediaAsset(video, { poster, subtitles: subs });
        expect(asset.poster_asset_id).toBe(2);
        expect(asset.poster_url).toBe('/api/blob/media/original/2/c.png');
        expect(asset.subtitles_asset_id).toBe(3);
        expect(asset.subtitles_url).toBe('/api/blob/media/original/3/c.vtt');
    });

    it('exposes ids without urls when linked rows are absent', () => {
        const video = row({ posterAssetId: 2, subtitlesAssetId: 3 });
        const asset = serializeMediaAsset(video);
        expect(asset.poster_asset_id).toBe(2);
        expect(asset.poster_url).toBeUndefined();
        expect(asset.subtitles_asset_id).toBe(3);
        expect(asset.subtitles_url).toBeUndefined();
    });

    it('omits poster fields when no poster is attached', () => {
        const asset = serializeMediaAsset(row({}));
        expect(asset.poster_asset_id).toBeUndefined();
        expect(asset.poster_url).toBeUndefined();
    });
});
