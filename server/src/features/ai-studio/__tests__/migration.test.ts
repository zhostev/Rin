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
    // 0021 依赖 ai_jobs（0013 建）
    sqlite.exec(readFileSync(join(SQL_DIR, '0013.sql'), 'utf8'));
    return sqlite;
}

describe('migration 0021.sql (stage4 ai_usage + ai_settings)', () => {
    it('creates ai_usage with the exact columns and indexes', () => {
        const sqlite = freshDb();
        sqlite.exec(readFileSync(join(SQL_DIR, '0021.sql'), 'utf8'));

        const columns = sqlite.query(`PRAGMA table_info(ai_usage)`).all() as Array<{ name: string }>;
        expect(columns.map((c) => c.name)).toEqual([
            'id', 'job_id', 'model', 'tokens_in', 'tokens_out', 'cost_usd_est', 'created_at',
        ]);

        const indexes = sqlite.query(
            `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ai_usage'`
        ).all() as Array<{ name: string }>;
        expect(indexes.map((i) => i.name)).toContain('ai_usage_created_idx');
        expect(indexes.map((i) => i.name)).toContain('ai_usage_model_idx');

        const version = sqlite.query(`SELECT value FROM info WHERE key='migration_version'`).get() as { value: string };
        expect(version.value).toBe('21');

        sqlite.close();
    });

    it('creates ai_settings with seeded defaults', () => {
        const sqlite = freshDb();
        sqlite.exec(readFileSync(join(SQL_DIR, '0021.sql'), 'utf8'));

        const columns = sqlite.query(`PRAGMA table_info(ai_settings)`).all() as Array<{ name: string }>;
        expect(columns.map((c) => c.name)).toEqual(['key', 'value', 'updated_at']);

        const rows = sqlite.query(`SELECT key, value FROM ai_settings ORDER BY key`).all() as Array<{ key: string; value: string }>;
        expect(rows).toEqual([
            { key: 'ai_enabled', value: '1' },
            { key: 'daily_call_quota', value: '200' },
        ]);

        sqlite.close();
    });

    it('is idempotent (re-running does not duplicate seeds)', () => {
        const sqlite = freshDb();
        const sql = readFileSync(join(SQL_DIR, '0021.sql'), 'utf8');
        sqlite.exec(sql);
        sqlite.exec(sql);

        const rows = sqlite.query(`SELECT COUNT(*) AS n FROM ai_settings`).get() as { n: number };
        expect(rows.n).toBe(2);

        const version = sqlite.query(`SELECT value FROM info WHERE key='migration_version'`).get() as { value: string };
        expect(version.value).toBe('21');

        sqlite.close();
    });

    it('records usage rows and supports the FK from ai_jobs', () => {
        const sqlite = freshDb();
        sqlite.exec(readFileSync(join(SQL_DIR, '0021.sql'), 'utf8'));

        sqlite.exec(`INSERT INTO ai_jobs (job_type, status) VALUES ('aistudio.embed', 'completed')`);
        sqlite.exec(
            `INSERT INTO ai_usage (job_id, model, tokens_in, tokens_out) VALUES (1, '@cf/baai/bge-base-en-v1.5', 12, 0)`
        );
        const row = sqlite.query(`SELECT * FROM ai_usage`).get() as Record<string, unknown>;
        expect(row.model).toBe('@cf/baai/bge-base-en-v1.5');
        expect(row.tokens_in).toBe(12);
        expect(typeof row.created_at).toBe('number');

        sqlite.close();
    });
});
