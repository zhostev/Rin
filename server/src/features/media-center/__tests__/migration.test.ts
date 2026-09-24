import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL_DIR = join(import.meta.dir, '../../../../sql');

function freshDb(): Database {
    const sqlite = new Database(':memory:');
    // 真实环境 info 表已存在（迁移版本号载体）；裸库需先建，与 fixtures/index.ts 一致
    sqlite.exec(`
        CREATE TABLE IF NOT EXISTS info (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL UNIQUE,
            value TEXT NOT NULL
        );
        INSERT OR IGNORE INTO info (key, value) VALUES ('migration_version', '0');
    `);
    sqlite.exec(readFileSync(join(SQL_DIR, '0013.sql'), 'utf8'));
    sqlite.exec(readFileSync(join(SQL_DIR, '0014.sql'), 'utf8'));
    return sqlite;
}

describe('migration 0020.sql (stage3 media events)', () => {
    it('creates media_events with the exact columns and index', () => {
        const sqlite = freshDb();
        sqlite.exec(readFileSync(join(SQL_DIR, '0020.sql'), 'utf8'));

        const columns = sqlite.query(`PRAGMA table_info(media_events)`).all() as Array<{ name: string }>;
        expect(columns.map((c) => c.name)).toEqual(['id', 'event_type', 'asset_id', 'story_id', 'created_at']);

        const indexes = sqlite.query(
            `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='media_events'`
        ).all() as Array<{ name: string }>;
        expect(indexes.map((i) => i.name)).toContain('media_events_type_created_idx');

        const version = sqlite.query(`SELECT value FROM info WHERE key='migration_version'`).get() as { value: string };
        expect(version.value).toBe('20');

        sqlite.close();
    });

    it('does not touch pre-existing tables', () => {
        const sqlite = freshDb();
        const before = (sqlite.query(
            `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
        ).all() as Array<{ name: string }>).map((r) => r.name);
        const mediaAssetsBefore = sqlite.query(`PRAGMA table_info(media_assets)`).all();

        sqlite.exec(readFileSync(join(SQL_DIR, '0020.sql'), 'utf8'));

        const after = (sqlite.query(
            `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
        ).all() as Array<{ name: string }>).map((r) => r.name);
        expect(after).toEqual([...before, 'media_events'].sort());
        expect(sqlite.query(`PRAGMA table_info(media_assets)`).all()).toEqual(mediaAssetsBefore);

        sqlite.close();
    });

    it('stores events without any PII columns', () => {
        const sqlite = freshDb();
        sqlite.exec(readFileSync(join(SQL_DIR, '0020.sql'), 'utf8'));

        sqlite.exec(`INSERT INTO media_events (event_type, asset_id, story_id) VALUES ('video_play', 7, 3)`);
        const row = sqlite.query(`SELECT * FROM media_events`).get() as Record<string, unknown>;
        expect(Object.keys(row).sort()).toEqual(['asset_id', 'created_at', 'event_type', 'id', 'story_id']);
        expect(row.event_type).toBe('video_play');
        expect(typeof row.created_at).toBe('number');

        sqlite.close();
    });
});
