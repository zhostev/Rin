import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createMockDB, createTestUser, cleanupTestDB } from '../../../../tests/fixtures';
import { applyStoryMigration } from '../../../../tests/fixtures/story';
import {
    deleteStoryById,
    findLegacyFeedByAlias,
    findStoryByFeedId,
    findStoryById,
    findStoryBySlug,
    insertStory,
    insertStoryBlocks,
    listStoryPage,
    replaceStoryBlocks,
    updateStoryById,
} from '../repository';
import type { Database } from 'bun:sqlite';

describe('story repository', () => {
    let db: any;
    let sqlite: Database;

    beforeEach(() => {
        const mock = createMockDB();
        db = mock.db;
        sqlite = mock.sqlite;
        applyStoryMigration(sqlite);
        // feeds.uid 有外键约束指向 users(id)，先建测试用户
        createTestUser(sqlite);
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });

    async function createStory(slug = 'hello-story') {
        const inserted = await insertStory(db, {
            slug,
            title: 'Hello',
            status: 'published',
            summary: 'summary',
            coverAssetId: null,
            feedId: null,
            publishedAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-02T00:00:00.000Z'),
            verifiedAt: null,
        });
        return inserted!.insertedId;
    }

    it('inserts a story and finds it by slug with blocks ordered by position', async () => {
        const id = await createStory();

        await insertStoryBlocks(db, id, [
            { type: 'rich_text', position: 1, payload: { markdown: 'second' } },
            { type: 'quote', position: 0, payload: { text: 'first' } },
        ]);

        const story = await findStoryBySlug(db, 'hello-story');
        expect(story?.id).toBe(id);
        expect(story?.slug).toBe('hello-story');
        expect(story?.status).toBe('published');
        expect(story?.blocks).toHaveLength(2);
        expect(story?.blocks[0].type).toBe('quote');
        expect(story?.blocks[1].type).toBe('rich_text');
        expect(JSON.parse(story!.blocks[0].payloadJson)).toEqual({ text: 'first' });
        expect(JSON.parse(story!.blocks[1].payloadJson)).toEqual({ markdown: 'second' });
    });

    it('returns undefined for an unknown slug', async () => {
        expect(await findStoryBySlug(db, 'missing')).toBeUndefined();
    });

    it('finds a story by id', async () => {
        const id = await createStory('by-id');
        const story = await findStoryById(db, id);
        expect(story?.slug).toBe('by-id');
        expect(await findStoryById(db, 9999)).toBeUndefined();
    });

    it('updates a story by id', async () => {
        const id = await createStory();
        await updateStoryById(db, id, { title: 'Renamed', status: 'updated' });

        const story = await findStoryById(db, id);
        expect(story?.title).toBe('Renamed');
        expect(story?.status).toBe('updated');
        expect(story?.slug).toBe('hello-story');
    });

    it('deletes a story together with its blocks', async () => {
        const id = await createStory();
        await insertStoryBlocks(db, id, [{ type: 'rich_text', payload: { markdown: 'x' } }]);

        await deleteStoryById(db, id);

        expect(await findStoryById(db, id)).toBeUndefined();
        const remaining = sqlite.query('SELECT COUNT(*) AS n FROM content_blocks').get() as { n: number };
        expect(remaining.n).toBe(0);
    });

    it('finds a story by feedId (post-to-story mapping key)', async () => {
        sqlite.exec(`INSERT INTO feeds (id, alias, title, content, uid, draft, listed) VALUES (7, 'old-alias', 'Old', 'md', 1, 0, 1)`);
        const inserted = await insertStory(db, {
            slug: 'mapped-story',
            title: 'Mapped',
            status: 'published',
            summary: '',
            coverAssetId: null,
            feedId: 7,
            publishedAt: null,
            updatedAt: new Date(),
            verifiedAt: null,
        });
        const id = inserted!.insertedId;

        const story = await findStoryByFeedId(db, 7);
        expect(story?.id).toBe(id);
        expect(story?.feedId).toBe(7);
        expect(await findStoryByFeedId(db, 12345)).toBeUndefined();
    });

    it('replaces all blocks of a story', async () => {
        const id = await createStory();
        await insertStoryBlocks(db, id, [
            { type: 'rich_text', payload: { markdown: 'old' } },
            { type: 'divider', payload: {} },
        ]);

        await replaceStoryBlocks(db, id, [
            { type: 'video', payload: { streamUid: 'abc' } },
        ]);

        const story = await findStoryById(db, id);
        expect(story?.blocks).toHaveLength(1);
        expect(story?.blocks[0].type).toBe('video');
        expect(story?.blocks[0].position).toBe(0);
    });

    it('lists stories with pagination', async () => {
        await createStory('s-1');
        await createStory('s-2');
        await createStory('s-3');

        const first = await listStoryPage(db, { pageIndex: 0, limit: 2 });
        expect(first.size).toBe(3);
        expect(first.rows).toHaveLength(2);
        expect(first.hasNext).toBe(true);

        const second = await listStoryPage(db, { pageIndex: 1, limit: 2 });
        expect(second.rows).toHaveLength(1);
        expect(second.hasNext).toBe(false);
    });

    it('finds a legacy feed by alias for the read-time fallback', async () => {
        sqlite.exec(`INSERT INTO feeds (id, alias, title, content, uid, draft, listed) VALUES (1, 'old-post', 'Old', '# md', 1, 0, 1)`);

        const feed = await findLegacyFeedByAlias(db, 'old-post');
        expect(feed?.alias).toBe('old-post');
        expect(feed?.content).toBe('# md');
        expect(await findLegacyFeedByAlias(db, 'missing')).toBeUndefined();
    });
});
