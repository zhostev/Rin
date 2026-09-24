/**
 * Stage 2 · media_assets 的 CRUD 封装（drizzle），供路由与 webhook 使用。
 * 业务语义（直传会话、变体回退、URL 派生）放在各功能模块；这里只做数据访问。
 */
import { count, desc, eq } from "drizzle-orm";
import type { DB } from "../../core/hono-types";
import { mediaAssets } from "../../db/schema";

type MediaAssetInsert = typeof mediaAssets.$inferInsert;
type MediaAssetUpdate = Partial<MediaAssetInsert>;
export type MediaAssetRow = typeof mediaAssets.$inferSelect;

export const MEDIA_KINDS = ["image", "video", "audio", "gallery", "attachment"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export function isMediaKind(value: unknown): value is MediaKind {
    return typeof value === "string" && (MEDIA_KINDS as readonly string[]).includes(value);
}

export function findMediaAssetById(db: DB, id: number) {
    return db.query.mediaAssets.findFirst({
        where: eq(mediaAssets.id, id),
    });
}

export function findMediaAssetByStreamUid(db: DB, uid: string) {
    return db.query.mediaAssets.findFirst({
        where: eq(mediaAssets.streamUid, uid),
    });
}

export function findMediaAssetByImagesId(db: DB, imagesId: string) {
    return db.query.mediaAssets.findFirst({
        where: eq(mediaAssets.imagesId, imagesId),
    });
}

export async function insertMediaAsset(db: DB, values: MediaAssetInsert) {
    const [inserted] = await db.insert(mediaAssets)
        .values(values)
        .returning({ insertedId: mediaAssets.id });
    return inserted ?? null;
}

export function updateMediaAssetById(db: DB, id: number, values: MediaAssetUpdate) {
    return db.update(mediaAssets).set(values).where(eq(mediaAssets.id, id));
}

export function deleteMediaAssetById(db: DB, id: number) {
    return db.delete(mediaAssets).where(eq(mediaAssets.id, id));
}

export interface ListMediaAssetsOptions {
    kind?: MediaKind;
    limit: number;
    offset: number;
}

export async function listMediaAssets(db: DB, options: ListMediaAssetsOptions) {
    const whereClause = options.kind ? eq(mediaAssets.kind, options.kind) : undefined;

    const [sizeRows, rows] = await Promise.all([
        whereClause
            ? db.select({ count: count() }).from(mediaAssets).where(whereClause)
            : db.select({ count: count() }).from(mediaAssets),
        db.query.mediaAssets.findMany({
            where: whereClause,
            orderBy: [desc(mediaAssets.id)],
            limit: options.limit + 1,
            offset: options.offset,
        }),
    ]);

    const hasNext = rows.length > options.limit;
    if (hasNext) {
        rows.pop();
    }

    return {
        size: sizeRows[0]?.count ?? 0,
        rows: rows as MediaAssetRow[],
        hasNext,
    };
}
