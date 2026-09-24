import {
    CONTENT_BLOCK_TYPES,
    STORY_STATUSES,
    storyCreateSchema,
    storyUpdateSchema,
} from "@rin/api";
import type {
    ContentBlockInput,
    ContentBlockType,
    CreateStoryRequest,
    Story,
    StoryStatus,
    UpdateStoryRequest,
} from "@rin/api";
import { Hono } from "hono";
import { inArray } from "drizzle-orm";
import type { Variables } from "../core/hono-types";
import { adminOnly, withJsonBody } from "../core/route-boundaries";
import { profileAsync } from "../core/server-timing";
import { transcripts } from "../db/schema";
import { deleteChunks } from "../features/ai-studio/embed";
import { extractAssetIds } from "../features/ai-studio/chunk";
import { buildStoryChunks } from "../features/ai-studio/processors";
import {
    deleteStoryById,
    findLegacyFeedByAlias,
    findStoryById,
    findStoryBySlug,
    insertStory,
    insertStoryBlocks,
    listStoryPage,
    replaceStoryBlocks,
    updateStoryById,
} from "../features/story/repository";

type StoryRow = NonNullable<Awaited<ReturnType<typeof findStoryBySlug>>>;
type LegacyFeedRow = NonNullable<Awaited<ReturnType<typeof findLegacyFeedByAlias>>>;

function parseStoryId(value: string): number | null {
    if (!/^[1-9]\d*$/.test(value)) {
        return null;
    }

    const id = Number(value);
    return Number.isSafeInteger(id) ? id : null;
}

function parsePositiveInteger(value: string | undefined, fallback: number, maximum?: number) {
    if (!value) {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return fallback;
    }

    return maximum ? Math.min(parsed, maximum) : parsed;
}

function serializeStory(row: StoryRow): Story {
    return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        status: row.status as StoryStatus,
        summary: row.summary,
        coverAssetId: row.coverAssetId,
        feedId: row.feedId,
        publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
        updatedAt: row.updatedAt.toISOString(),
        verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
        blocks: row.blocks.map((block) => ({
            id: block.id,
            storyId: block.storyId,
            type: block.type as ContentBlockType,
            position: block.position,
            payloadJson: block.payloadJson,
            revision: block.revision,
        })),
    };
}

/**
 * post-to-story 映射（读取时 fallback，零迁移、零写旧表）：
 * 旧文章自动映射为"单个 rich_text block" 的 story 视图。
 * 该视图是临时的（fromLegacyFeed: true），id/feedId 复用 feeds.id。
 */
function synthesizeStoryFromFeed(feed: LegacyFeedRow): Story {
    return {
        id: feed.id,
        slug: feed.alias ?? String(feed.id),
        title: feed.title,
        status: feed.draft ? 'draft' : 'published',
        summary: feed.summary,
        coverAssetId: null,
        feedId: feed.id,
        publishedAt: feed.createdAt.toISOString(),
        updatedAt: feed.updatedAt.toISOString(),
        verifiedAt: null,
        fromLegacyFeed: true,
        blocks: [
            {
                id: 1,
                storyId: feed.id,
                type: 'rich_text',
                position: 0,
                payloadJson: JSON.stringify({ markdown: feed.content }),
                revision: 1,
            },
        ],
    };
}

function validateBlockTypes(blocks: ContentBlockInput[] | undefined): string | null {
    for (const block of blocks ?? []) {
        if (!CONTENT_BLOCK_TYPES.includes(block.type)) {
            return `Invalid block type: ${block.type}`;
        }
    }
    return null;
}

/**
 * 公开读服务（挂载到 /story → 对外 /api/story）。
 * GET /:slug：先查 stories.slug；不存在则查 feeds.alias，命中时合成为单
 * rich_text block 的 story 视图返回。旧 /:alias 与 /feed/:id 链路不受影响。
 */
export function StoryService(): Hono<{
    Bindings: Env;
    Variables: Variables;
}> {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();

    // GET /story/:slug
    // 解析顺序：stories.slug → 纯数字时 stories.id → feeds.alias（旧文 fallback）。
    // 数字 id 兼容供后台编辑器直接读取（可见性规则与 slug 一致）。
    app.get('/:slug', async (c) => {
        const db = c.get('db');
        const admin = c.get('admin');
        const uid = c.get('uid');
        const slug = c.req.param('slug');

        // stories.slug 优先于 feeds.alias
        let story = await profileAsync(c, 'story_detail_db', () => findStoryBySlug(db, slug));

        if (!story && parseStoryId(slug) !== null) {
            story = await profileAsync(c, 'story_detail_db_id', () =>
                findStoryById(db, parseStoryId(slug) as number));
        }

        if (story) {
            const isPublic = story.status === 'published' || story.status === 'updated';
            if (!isPublic && !admin) {
                return c.text('Permission denied', 403);
            }
            return c.json(serializeStory(story));
        }

        const feed = await profileAsync(c, 'story_detail_legacy_db', () => findLegacyFeedByAlias(db, slug));

        if (!feed) {
            return c.text('Not found', 404);
        }

        // 与 /feed/:id 一致的草稿可见性规则
        if (feed.draft && feed.uid !== uid && !admin) {
            return c.text('Permission denied', 403);
        }

        return c.json(synthesizeStoryFromFeed(feed));
    });

    return app;
}

/**
 * 管理端服务（挂载到 /admin/stories → 对外 /api/admin/stories）。
 * 全部路由走 adminOnly 守卫（未授权默认 401）。
 */
export function AdminStoryService(): Hono<{
    Bindings: Env;
    Variables: Variables;
}> {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();

    // GET /admin/stories - 管理端列表
    app.get('/', adminOnly(async (c) => {
        const db = c.get('db');
        const page = c.req.query('page');
        const limit = c.req.query('limit');
        const page_num = parsePositiveInteger(page, 1) - 1;
        const limit_num = parsePositiveInteger(limit, 20, 50);

        const result = await profileAsync(c, 'story_admin_list_db', () => listStoryPage(db, {
            pageIndex: page_num,
            limit: limit_num,
        }));

        return c.json({
            size: result.size,
            data: result.rows.map(serializeStory),
            hasNext: result.hasNext,
        });
    }));

    // POST /admin/stories - 新建 story（可附带内容块）
    app.post('/', adminOnly(withJsonBody<CreateStoryRequest>(storyCreateSchema, async (c, body) => {
        const db = c.get('db');
        const { slug, title, status, summary, coverAssetId, feedId, publishedAt, blocks } = body;

        if (status !== undefined && !STORY_STATUSES.includes(status)) {
            return c.text(`Invalid status: ${status}`, 400);
        }

        const blockError = validateBlockTypes(blocks);
        if (blockError) {
            return c.text(blockError, 400);
        }

        const existing = await profileAsync(c, 'story_create_existing', () => findStoryBySlug(db, slug));
        if (existing) {
            return c.text('Slug already exists', 400);
        }

        const now = new Date();
        const inserted = await profileAsync(c, 'story_create_insert', () => insertStory(db, {
            slug,
            title: title ?? null,
            status: status ?? 'draft',
            summary: summary ?? "",
            coverAssetId: coverAssetId ?? null,
            feedId: feedId ?? null,
            publishedAt: publishedAt ? new Date(publishedAt) : null,
            updatedAt: now,
            verifiedAt: null,
        }));

        if (!inserted) {
            return c.text('Failed to insert', 500);
        }

        await profileAsync(c, 'story_create_blocks', () => insertStoryBlocks(db, inserted.insertedId, blocks ?? []));

        const created = await profileAsync(c, 'story_create_reload', () => findStoryById(db, inserted.insertedId));
        return c.json(created ? serializeStory(created) : { id: inserted.insertedId }, 201);
    }, {
        errorMessage: (issues) => {
            if (issues.some((issue) => issue.path === 'slug' && /required|empty/.test(issue.message))) {
                return 'Slug is required';
            }
            return issues[0]?.message ?? 'Invalid request body';
        },
    })));

    // GET /admin/stories/:id - 管理端详情（含草稿）
    app.get('/:id', adminOnly(async (c) => {
        const db = c.get('db');
        const id = parseStoryId(c.req.param('id'));
        if (id === null) {
            return c.text('Not found', 404);
        }

        const story = await profileAsync(c, 'story_admin_detail_db', () => findStoryById(db, id));
        if (!story) {
            return c.text('Not found', 404);
        }

        return c.json(serializeStory(story));
    }));

    // PUT /admin/stories/:id - 更新 story；传入 blocks 时整体替换内容块
    app.put('/:id', adminOnly(withJsonBody<UpdateStoryRequest>(storyUpdateSchema, async (c, body) => {
        const db = c.get('db');
        const id = parseStoryId(c.req.param('id'));
        if (id === null) {
            return c.text('Not found', 404);
        }

        const story = await profileAsync(c, 'story_update_lookup', () => findStoryById(db, id));
        if (!story) {
            return c.text('Not found', 404);
        }

        if (body.status !== undefined && !STORY_STATUSES.includes(body.status)) {
            return c.text(`Invalid status: ${body.status}`, 400);
        }

        const blockError = validateBlockTypes(body.blocks);
        if (blockError) {
            return c.text(blockError, 400);
        }

        if (body.slug !== undefined && body.slug !== story.slug) {
            const duplicate = await profileAsync(c, 'story_update_slug_check', () => findStoryBySlug(db, body.slug as string));
            if (duplicate) {
                return c.text('Slug already exists', 400);
            }
        }

        // 只收集显式传入的字段，避免把 undefined 写进 SQL
        const patch: {
            slug?: string;
            title?: string | null;
            status?: StoryStatus;
            summary?: string;
            coverAssetId?: number | null;
            feedId?: number | null;
            publishedAt?: Date;
            verifiedAt?: Date;
            updatedAt: Date;
        } = { updatedAt: new Date() };
        if (body.slug !== undefined) patch.slug = body.slug;
        if (body.title !== undefined) patch.title = body.title;
        if (body.status !== undefined) patch.status = body.status;
        if (body.summary !== undefined) patch.summary = body.summary;
        if (body.coverAssetId !== undefined) patch.coverAssetId = body.coverAssetId;
        if (body.feedId !== undefined) patch.feedId = body.feedId;
        if (body.publishedAt !== undefined) patch.publishedAt = new Date(body.publishedAt);
        if (body.verifiedAt !== undefined) patch.verifiedAt = new Date(body.verifiedAt);

        await profileAsync(c, 'story_update_db', () => updateStoryById(db, id, patch));

        if (body.blocks !== undefined) {
            await profileAsync(c, 'story_update_blocks', () => replaceStoryBlocks(db, id, body.blocks ?? []));
        }

        const updated = await profileAsync(c, 'story_update_reload', () => findStoryById(db, id));
        return c.json(updated ? serializeStory(updated) : null);
    })));

    // DELETE /admin/stories/:id - 删除 story 及其内容块
    app.delete('/:id', adminOnly(async (c) => {
        const db = c.get('db');
        const id = parseStoryId(c.req.param('id'));
        if (id === null) {
            return c.text('Not found', 404);
        }

        const story = await profileAsync(c, 'story_delete_lookup', () => findStoryById(db, id));
        if (!story) {
            return c.text('Not found', 404);
        }

        // 同步清理该 story 在向量索引中的块：避免删除后问答仍引用已删内容，
        // 也避免 SQLite 复用 id 时新 story 与旧向量碰撞。失败不阻塞删除。
        try {
            const assetIds = new Set<number>();
            for (const block of story.blocks) {
                for (const aid of extractAssetIds(block.payloadJson)) assetIds.add(aid);
            }
            const trs = assetIds.size > 0
                ? await db.query.transcripts.findMany({
                    where: inArray(transcripts.assetId, [...assetIds]),
                })
                : [];
            const chunks = buildStoryChunks(
                { story, blocks: story.blocks, transcripts: trs },
                `/story/${story.slug}`,
            );
            await profileAsync(c, 'story_delete_vectors', () =>
                deleteChunks(c.env as Env, chunks.map((chunk) => chunk.id)));
        } catch {
            // 向量清理失败不阻塞 story 删除
        }

        await profileAsync(c, 'story_delete_db', () => deleteStoryById(db, id));
        return c.text('Deleted');
    }));

    return app;
}
