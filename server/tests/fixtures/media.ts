import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

/**
 * 将 Stage 2 媒体栈增量迁移（server/sql/0013.sql、0014.sql）应用到测试库。
 *
 * 0014 是 0013 的增量（ALTER TABLE media_assets），因此先应用 0013 建表，
 * 再应用 0014 加列——与生产迁移顺序一致。`--> statement-breakpoint`
 * 行会被 SQLite 当作 `--` 行注释忽略，可直接整体执行。
 *
 * 注意：createMockDB 建的 media_assets 已是新模型（与 0013+0014+0018 对齐），
 * 此时 0013 的 CREATE TABLE IF NOT EXISTS 会跳过、0014 的增列会报
 * duplicate column（由 execMigrationLenient 容忍）。ensureMediaAssetsColumns
 * 只是一个安全网：若某天 fixture 表又缺了 0013 时代的列，在跑迁移前补上，
 * 避免 `media_assets_kind_idx` 索引因缺 `kind` 列而失败（历史 84 失败的主因）。
 */
export function applyMediaMigration(sqlite: Database) {
    const dir = join(import.meta.dir, "../../sql");
    ensureMediaAssetsColumns(sqlite);
    for (const file of ["0013.sql", "0014.sql"]) {
        execMigrationLenient(sqlite, readFileSync(join(dir, file), "utf8"));
    }
}

/**
 * 0013 建表时 media_assets 应有的列（0014 只增 title/stream_* 等列，
 * 下面这些是 0014 没覆盖、旧 fixture 表缺的）。
 */
const MEDIA_ASSETS_0013_COLUMNS: Array<[string, string]> = [
    ["kind", "TEXT DEFAULT 'image' NOT NULL"],
    ["source", "TEXT DEFAULT 'r2' NOT NULL"],
    ["r2_key", "TEXT DEFAULT ''"],
    ["stream_uid", "TEXT DEFAULT ''"],
    ["mime", "TEXT DEFAULT ''"],
    ["duration", "REAL"],
    ["width", "INTEGER"],
    ["height", "INTEGER"],
    ["alt_text", "TEXT DEFAULT ''"],
    ["created_at", "INTEGER"],
    ["updated_at", "INTEGER"],
];

/**
 * fixture 旧 media_assets 表缺 0013 时代的列时补上；已有的列不动。
 */
export function ensureMediaAssetsColumns(sqlite: Database) {
    const table = sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media_assets'")
        .get() as { name: string } | null;
    // 表不存在时由 0013 原样建新表，这里什么都不做。
    if (!table) return;
    const existing = new Set(
        (sqlite.query("PRAGMA table_info(media_assets)").all() as Array<{ name: string }>).map(
            (c) => c.name,
        ),
    );
    for (const [name, def] of MEDIA_ASSETS_0013_COLUMNS) {
        if (!existing.has(name)) {
            sqlite.exec(`ALTER TABLE media_assets ADD COLUMN ${name} ${def}`);
            existing.add(name);
        }
    }
}

/**
 * 按 `--> statement-breakpoint` 逐条执行迁移 SQL。
 *
 * 与生产行为的差别（仅测试 fixture 需要）：
 * - fixture 旧表自带 `moment_id` 列（见 tests/fixtures/index.ts），0018 的
 *   `ADD COLUMN moment_id` 会报 duplicate column name——跳过该条。
 * - fixture 已建好 `analytics_daily` / `analytics_dim_daily`（见
 *   tests/fixtures/index.ts），0016 的 CREATE TABLE 会报 already exists——跳过该条。
 * 其余语句照常执行，生产迁移文件本身不做任何修改。
 */
export function execMigrationLenient(sqlite: Database, sql: string) {
    for (const chunk of sql.split(/-->\s*statement-breakpoint/)) {
        const stmt = chunk.trim();
        if (!stmt) continue;
        try {
            sqlite.exec(stmt);
        } catch (err) {
            if (err instanceof Error && /duplicate column name|already exists/i.test(err.message)) continue;
            throw err;
        }
    }
}
