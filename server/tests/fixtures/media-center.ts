import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { ensureMediaAssetsColumns, execMigrationLenient } from "./media";

/**
 * 将 Stage 1–3 增量迁移按真实编号顺序应用到测试库。
 *
 * 0013 建 stage1 内容模型表（含 stories/content_blocks/transcripts/series），
 * 0014 给 media_assets 增列，
 * 0015–0019 为上游基线迁移（comments 地理列、analytics 聚合表、sharing_reports/finance_transactions、
 * media_assets.moment_id、feeds AI 写作列），
 * 0020 建 media_events——与生产迁移顺序一致。
 * `--> statement-breakpoint` 行会被 SQLite 当作 `--` 行注释忽略，可直接整体执行。
 *
 * 旧 fixture media_assets 表的对齐逻辑见 ./media（补 0013 时代列、
 * 容忍 fixture 自带的 moment_id 与 0018 重复）。
 */
export function applyMediaCenterMigration(sqlite: Database) {
    const dir = join(import.meta.dir, "../../sql");
    ensureMediaAssetsColumns(sqlite);
    for (const file of ["0013.sql", "0014.sql", "0015.sql", "0016.sql", "0017.sql", "0018.sql", "0019.sql", "0020.sql"]) {
        execMigrationLenient(sqlite, readFileSync(join(dir, file), "utf8"));
    }
}
