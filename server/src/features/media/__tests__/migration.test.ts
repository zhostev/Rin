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
    return sqlite;
}

describe('migration 0014.sql (stage2 media stack)', () => {
    it('applies cleanly on top of 0013: adds columns with defaults + index', () => {
        const sqlite = freshDb();
        sqlite.exec(readFileSync(join(SQL_DIR, '0014.sql'), 'utf8'));

        const columns = sqlite.query(`PRAGMA table_info(media_assets)`).all() as Array<{ name: string; dflt_value: string | null; notnull: number }>;
        const byName = new Map(columns.map((c) => [c.name, c]));

        for (const name of ['title', 'stream_status', 'stream_error', 'stream_meta_json', 'images_id', 'images_variants_json', 'upload_session_json']) {
            expect(byName.has(name), `column ${name} exists`).toBe(true);
        }
        expect(byName.get('stream_status')!.dflt_value).toBe("'ready'");
        expect(byName.get('stream_meta_json')!.dflt_value).toBe("'{}'");
        expect(byName.get('stream_meta_json')!.notnull).toBe(1);
        expect(byName.get('images_variants_json')!.dflt_value).toBe("'{}'");
        expect(byName.get('upload_session_json')!.dflt_value).toBe("'{}'");

        const indexes = sqlite.query(
            `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='media_assets'`
        ).all() as Array<{ name: string }>;
        expect(indexes.map((i) => i.name)).toContain('media_assets_stream_uid_idx');

        sqlite.close();
    });

    it('keeps pre-existing rows usable: old rows default to stream_status=ready', () => {
        const sqlite = freshDb();
        sqlite.exec(`INSERT INTO media_assets (kind, source, mime) VALUES ('audio', 'r2', 'audio/mpeg')`);
        sqlite.exec(readFileSync(join(SQL_DIR, '0014.sql'), 'utf8'));

        const row = sqlite.query(`SELECT stream_status, stream_error, stream_meta_json, images_variants_json, upload_session_json FROM media_assets`).get() as Record<string, string>;
        expect(row.stream_status).toBe('ready');
        expect(row.stream_error).toBe('');
        expect(row.stream_meta_json).toBe('{}');
        expect(row.images_variants_json).toBe('{}');
        expect(row.upload_session_json).toBe('{}');

        sqlite.close();
    });

    it('is idempotent (IF NOT EXISTS index; re-running ALTERs would fail on sqlite, so run once)', () => {
        // 0014 的 ALTER TABLE 在 SQLite 上不可重复执行（与 0013 的 CREATE TABLE
        // IF NOT EXISTS 不同），幂等性由迁移版本号（info.migration_version）保证。
        // 这里只验证版本号语句存在且语法合法。
        const sql = readFileSync(join(SQL_DIR, '0014.sql'), 'utf8');
        expect(sql).toContain(`UPDATE \`info\` SET \`value\` = '14'`);
    });
});

describe('migration 0023.sql (R2 video chain: poster/subtitles refs)', () => {
    it('adds poster_asset_id/subtitles_asset_id columns + indexes', () => {
        const sqlite = freshDb();
        sqlite.exec(readFileSync(join(SQL_DIR, '0014.sql'), 'utf8'));
        sqlite.exec(readFileSync(join(SQL_DIR, '0023.sql'), 'utf8'));

        const columns = sqlite.query(`PRAGMA table_info(media_assets)`).all() as Array<{ name: string }>;
        const names = new Set(columns.map((c) => c.name));
        expect(names.has('poster_asset_id')).toBe(true);
        expect(names.has('subtitles_asset_id')).toBe(true);

        const indexes = sqlite.query(
            `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='media_assets'`
        ).all() as Array<{ name: string }>;
        expect(indexes.map((i) => i.name)).toContain('media_assets_poster_idx');
        expect(indexes.map((i) => i.name)).toContain('media_assets_subtitles_idx');

        const version = sqlite.query(`SELECT value FROM info WHERE key='migration_version'`).get() as { value: string };
        expect(version.value).toBe('23');

        sqlite.close();
    });

    it('keeps pre-existing rows usable: old rows have NULL refs', () => {
        const sqlite = freshDb();
        sqlite.exec(`INSERT INTO media_assets (kind, source, mime) VALUES ('video', 'r2', 'video/mp4')`);
        sqlite.exec(readFileSync(join(SQL_DIR, '0014.sql'), 'utf8'));
        sqlite.exec(readFileSync(join(SQL_DIR, '0023.sql'), 'utf8'));

        const row = sqlite.query(`SELECT poster_asset_id, subtitles_asset_id FROM media_assets`).get() as Record<string, unknown>;
        expect(row.poster_asset_id).toBeNull();
        expect(row.subtitles_asset_id).toBeNull();

        sqlite.close();
    });
});
