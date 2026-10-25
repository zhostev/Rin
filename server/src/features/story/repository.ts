import { asc, count, desc, eq, inArray } from "drizzle-orm";
import type { DB } from "../../core/hono-types";
import { contentBlocks, feeds, stories } from "../../db/schema";
import type { ContentBlockInput } from "@rin/api";

type StoryInsert = typeof stories.$inferInsert;
type StoryUpdate = Partial<StoryInsert>;
type StoryRow = typeof stories.$inferSelect;
export type StoryWithBlocks = StoryRow & {
    blocks: Array<typeof contentBlocks.$inferSelect>;
};

const blocksOrder = [asc(contentBlocks.position), asc(contentBlocks.id)];

export function findStoryById(db: DB, id: number) {
    return db.query.stories.findFirst({
        where: eq(stories.id, id),
        with: { blocks: { orderBy: blocksOrder } },
    });
}

export function findStoryBySlug(db: DB, slug: string) {
    return db.query.stories.findFirst({
        where: eq(stories.slug, slug),
        with: { blocks: { orderBy: blocksOrder } },
    });
}

/** post-to-story 映射键：找出已绑定到某篇旧文章的 story */
export function findStoryByFeedId(db: DB, feedId: number) {
    return db.query.stories.findFirst({
        where: eq(stories.feedId, feedId),
        with: { blocks: { orderBy: blocksOrder } },
    });
}

/**
 * 读取时 fallback 用的旧文章查询（只读，不迁移、不写旧表）。
 * 命中 feeds.alias 时，service 层将其合成为单 rich_text block 的 story 视图。
 */
export function findLegacyFeedByAlias(db: DB, alias: string) {
    return db.query.feeds.findFirst({
        where: eq(feeds.alias, alias),
    });
}

export async function insertStory(db: DB, values: StoryInsert) {
    const [inserted] = await db.insert(stories)
        .values(values)
        .returning({ insertedId: stories.id });
    return inserted ?? null;
}

export function updateStoryById(db: DB, id: number, values: StoryUpdate) {
    return db.update(stories).set(values).where(eq(stories.id, id));
}

export async function deleteStoryById(db: DB, id: number) {
    // 显式先删内容块：不依赖运行时的 FK 级联开关（bun:sqlite 默认关闭）
    await db.delete(contentBlocks).where(eq(contentBlocks.storyId, id));
    return db.delete(stories).where(eq(stories.id, id));
}

/**
 * D1 caps a single statement at 100 bound parameters
 * (https://developers.cloudflare.com/d1/platform/limits/). A content-block
 * row binds 5 parameters, so one multi-row INSERT tops out at exactly 20
 * blocks — a 21st block used to fail with "too many SQL variables". Insert
 * in batches of 10 blocks (50 parameters) so the ceiling is never approached,
 * no matter how many blocks a story has.
 */
const STORY_BLOCK_INSERT_BATCH_SIZE = 10;

export async function insertStoryBlocks(db: DB, storyId: number, inputs: ContentBlockInput[]) {
    if (inputs.length === 0) {
        return [];
    }
    const inserted: Array<{ insertedId: number }> = [];
    for (let start = 0; start < inputs.length; start += STORY_BLOCK_INSERT_BATCH_SIZE) {
        const batch = inputs.slice(start, start + STORY_BLOCK_INSERT_BATCH_SIZE);
        const rows = await db.insert(contentBlocks).values(batch.map((input, index) => ({
            storyId,
            type: input.type,
            position: input.position ?? start + index,
            payloadJson: JSON.stringify(input.payload ?? {}),
            revision: input.revision ?? 1,
        }))).returning({ insertedId: contentBlocks.id });
        inserted.push(...rows);
    }
    return inserted;
}

/** 整体替换某 story 的内容块（先删后插，position 按传入顺序重排） */
export async function replaceStoryBlocks(db: DB, storyId: number, inputs: ContentBlockInput[]) {
    await db.delete(contentBlocks).where(eq(contentBlocks.storyId, storyId));
    return insertStoryBlocks(db, storyId, inputs);
}

export type ListStoryPageOptions = {
    pageIndex: number;
    limit: number;
};

/**
 * 公开故事列表：只含 published/updated 的故事，且不带 blocks 全量——列表页
 * 只需标题/简介/时间/封面资产 id，块内容走 /story/:slug 单页读取。
 */
export async function listVisibleStoryPage(db: DB, options: ListStoryPageOptions) {
    const [sizeRows, rows] = await Promise.all([
        db.select({ count: count() }).from(stories).where(inArray(stories.status, ['published', 'updated'])),
        db.select({
            id: stories.id,
            slug: stories.slug,
            title: stories.title,
            summary: stories.summary,
            status: stories.status,
            coverAssetId: stories.coverAssetId,
            publishedAt: stories.publishedAt,
            updatedAt: stories.updatedAt,
            verifiedAt: stories.verifiedAt,
        }).from(stories)
            .where(inArray(stories.status, ['published', 'updated']))
            .orderBy(desc(stories.updatedAt), desc(stories.id))
            .offset(options.pageIndex * options.limit)
            .limit(options.limit + 1),
    ]);

    const hasNext = rows.length > options.limit;
    if (hasNext) {
        rows.pop();
    }

    return {
        size: sizeRows[0]?.count ?? 0,
        rows,
        hasNext,
    };
}

export async function listStoryPage(db: DB, options: ListStoryPageOptions) {
    const [sizeRows, rows] = await Promise.all([
        db.select({ count: count() }).from(stories),
        db.query.stories.findMany({
            with: { blocks: { orderBy: blocksOrder } },
            orderBy: [desc(stories.updatedAt), desc(stories.id)],
            offset: options.pageIndex * options.limit,
            limit: options.limit + 1,
        }),
    ]);

    const hasNext = rows.length > options.limit;
    if (hasNext) {
        rows.pop();
    }

    return {
        size: sizeRows[0]?.count ?? 0,
        rows: rows as StoryWithBlocks[],
        hasNext,
    };
}
