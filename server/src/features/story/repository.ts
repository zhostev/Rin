import { asc, count, desc, eq } from "drizzle-orm";
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

export async function insertStoryBlocks(db: DB, storyId: number, inputs: ContentBlockInput[]) {
    if (inputs.length === 0) {
        return [];
    }
    return db.insert(contentBlocks).values(inputs.map((input, index) => ({
        storyId,
        type: input.type,
        position: input.position ?? index,
        payloadJson: JSON.stringify(input.payload ?? {}),
        revision: input.revision ?? 1,
    }))).returning({ insertedId: contentBlocks.id });
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
