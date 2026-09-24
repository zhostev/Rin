import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from '../../../db/schema';
import {
    verifyStreamWebhookSignature,
    extractWebhookVideo,
    applyStreamWebhook,
    WebhookConfigError,
} from '../webhook';
import { findMediaAssetByStreamUid } from '../repository';

const SECRET = 'whsec_test_secret';

async function sign(body: string, secret: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function seedDb(): { sqlite: Database; db: any } {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
        CREATE TABLE media_assets (
            id INTEGER PRIMARY KEY,
            kind TEXT DEFAULT 'image' NOT NULL,
            source TEXT DEFAULT 'r2' NOT NULL,
            r2_key TEXT,
            stream_uid TEXT,
            mime TEXT DEFAULT '' NOT NULL,
            duration INTEGER,
            width INTEGER,
            height INTEGER,
            alt_text TEXT DEFAULT '',
            title TEXT DEFAULT '',
            stream_status TEXT DEFAULT 'ready',
            stream_error TEXT DEFAULT '',
            stream_meta_json TEXT DEFAULT '{}' NOT NULL,
            images_id TEXT DEFAULT '',
            images_variants_json TEXT DEFAULT '{}' NOT NULL,
            upload_session_json TEXT DEFAULT '{}' NOT NULL,
            created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
            updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
        );
        CREATE INDEX media_assets_stream_uid_idx ON media_assets (stream_uid);
    `);
    const db = drizzle(sqlite, { schema });
    sqlite.exec(`INSERT INTO media_assets (kind, source, stream_uid, stream_status) VALUES ('video', 'stream', 'vid_1', 'uploading')`);
    return { sqlite, db };
}

describe('verifyStreamWebhookSignature', () => {
    it('accepts a valid signature', async () => {
        const body = '{"uid":"vid_1"}';
        const signature = await sign(body, SECRET);
        expect(await verifyStreamWebhookSignature(body, signature, SECRET)).toBe(true);
    });

    it('accepts uppercase hex signature', async () => {
        const body = '{"uid":"vid_1"}';
        const signature = (await sign(body, SECRET)).toUpperCase();
        expect(await verifyStreamWebhookSignature(body, signature, SECRET)).toBe(true);
    });

    it('rejects a wrong signature', async () => {
        const body = '{"uid":"vid_1"}';
        const signature = await sign('{"uid":"vid_2"}', SECRET);
        expect(await verifyStreamWebhookSignature(body, signature, SECRET)).toBe(false);
    });

    it('rejects a missing signature', async () => {
        expect(await verifyStreamWebhookSignature('{}', null, SECRET)).toBe(false);
        expect(await verifyStreamWebhookSignature('{}', '', SECRET)).toBe(false);
    });

    it('throws WebhookConfigError when secret is missing (never silently passes)', async () => {
        await expect(verifyStreamWebhookSignature('{}', 'abc', '')).rejects.toBeInstanceOf(WebhookConfigError);
        await expect(verifyStreamWebhookSignature('{}', 'abc', undefined)).rejects.toBeInstanceOf(WebhookConfigError);
    });
});

describe('extractWebhookVideo', () => {
    it('extracts the flat documented payload', () => {
        const video = extractWebhookVideo({
            uid: 'vid_1',
            status: { state: 'ready', pctComplete: '100.000000', errorReasonCode: '', errorReasonText: '' },
            duration: 42.5,
            thumbnail: 'https://videodelivery.net/vid_1/thumbnails/thumbnail.jpg',
            readyToStream: true,
            meta: { name: 'a.mp4' },
        });
        expect(video?.uid).toBe('vid_1');
        expect(video?.state).toBe('ready');
        expect(video?.duration).toBe(42.5);
        expect(video?.name).toBe('a.mp4');
    });

    it('supports a {video:{...}} wrapped payload defensively', () => {
        const video = extractWebhookVideo({ video: { uid: 'vid_2', status: { state: 'inprogress' } } });
        expect(video?.uid).toBe('vid_2');
        expect(video?.state).toBe('inprogress');
    });

    it('returns null without a uid', () => {
        expect(extractWebhookVideo({ status: { state: 'ready' } })).toBeNull();
        expect(extractWebhookVideo(null)).toBeNull();
        expect(extractWebhookVideo('nope')).toBeNull();
    });
});

describe('applyStreamWebhook (state machine)', () => {
    let sqlite: Database;
    let db: any;

    beforeEach(() => {
        ({ sqlite, db } = seedDb());
    });

    afterEach(() => {
        sqlite.close();
    });

    const payloadFor = (state: string, extra: Record<string, unknown> = {}) => ({
        uid: 'vid_1',
        status: { state, pctComplete: '50', errorReasonCode: '', errorReasonText: '', ...extra },
        duration: 90.2,
        thumbnail: 'https://videodelivery.net/vid_1/thumbnails/thumbnail.jpg',
        readyToStream: state === 'ready',
    });

    it('advances uploading -> processing -> ready and stores meta', async () => {
        let result = await applyStreamWebhook(db, payloadFor('inprogress'));
        expect(result).toMatchObject({ handled: true, deduped: false, to: 'processing' });

        let row = await findMediaAssetByStreamUid(db, 'vid_1');
        expect(row?.streamStatus).toBe('processing');
        const meta = JSON.parse(row?.streamMetaJson ?? '{}');
        expect(meta.duration).toBe(90.2);
        expect(meta.lastSyncAt).toBeTruthy();

        result = await applyStreamWebhook(db, payloadFor('ready'));
        expect(result).toMatchObject({ handled: true, to: 'ready' });
        row = await findMediaAssetByStreamUid(db, 'vid_1');
        expect(row?.streamStatus).toBe('ready');
        expect(row?.duration).toBe(90);
    });

    it('is idempotent on repeated callbacks (no side effects)', async () => {
        await applyStreamWebhook(db, payloadFor('ready'));
        const before = await findMediaAssetByStreamUid(db, 'vid_1');
        const result = await applyStreamWebhook(db, payloadFor('ready'));
        expect(result).toMatchObject({ handled: true, deduped: true });
        const after = await findMediaAssetByStreamUid(db, 'vid_1');
        expect(after).toBeTruthy();
        expect(before).toBeTruthy();
        expect(after!.streamStatus).toBe(before!.streamStatus);
        expect(after!.streamMetaJson).toBe(before!.streamMetaJson);
    });

    it('records stream_error on error state', async () => {
        const result = await applyStreamWebhook(
            db,
            payloadFor('error', { errorReasonCode: 'ERR_DURATION', errorReasonText: 'too long' }),
        );
        expect(result).toMatchObject({ handled: true, to: 'error' });
        const row = await findMediaAssetByStreamUid(db, 'vid_1');
        expect(row?.streamStatus).toBe('error');
        expect(row?.streamError).toBe('too long');
    });

    it('ignores stale transitions (ready -> processing)', async () => {
        await applyStreamWebhook(db, payloadFor('ready'));
        const result = await applyStreamWebhook(db, payloadFor('inprogress'));
        expect(result).toMatchObject({ handled: false, reason: 'stale' });
        const row = await findMediaAssetByStreamUid(db, 'vid_1');
        expect(row?.streamStatus).toBe('ready');
    });

    it('returns unknown_uid for unrecognized uids (caller acks 200)', async () => {
        const result = await applyStreamWebhook(db, { uid: 'nope', status: { state: 'ready' } });
        expect(result).toMatchObject({ handled: false, reason: 'unknown_uid' });
    });

    it('returns missing_uid when payload has no uid', async () => {
        const result = await applyStreamWebhook(db, { status: { state: 'ready' } });
        expect(result).toMatchObject({ handled: false, reason: 'missing_uid' });
    });
});
