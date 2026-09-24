import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

/**
 * 将 Stage 1–3 增量迁移按真实编号顺序应用到测试库。
 *
 * 0013 建 stage1 内容模型表（含 stories/content_blocks/transcripts/series），
 * 0014 给 media_assets 增列，
 * 0015–0019 为上游基线迁移（comments 地理列、analytics 聚合表、sharing_reports/finance_transactions、
 * media_assets.moment_id、feeds AI 写作列），
 * 0020 建 media_events——与生产迁移顺序一致。
 * `--> statement-breakpoint` 行会被 SQLite 当作 `--` 行注释忽略，可直接整体执行。
 */
export function applyMediaCenterMigration(sqlite: Database) {
    const dir = join(import.meta.dir, "../../sql");
    for (const file of ["0013.sql", "0014.sql", "0015.sql", "0016.sql", "0017.sql", "0018.sql", "0019.sql", "0020.sql"]) {
        sqlite.exec(readFileSync(join(dir, file), "utf8"));
    }
}
