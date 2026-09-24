import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from "hono";
import type { Variables } from "../../core/hono-types";
import { setupTestApp, createTestUser, cleanupTestDB } from '../../../tests/fixtures';
import { applyStoryMigration } from '../../../tests/fixtures/story';
import { AdminStoryService, StoryService } from '../story';
import { insertStory, insertStoryBlocks } from '../../features/story/repository';
import type { Database } from 'bun:sqlite';

const ADMIN_HEADERS = {
    'Authorization': 'Bearer mock_token_1',
    'Content-Type': 'application/json',
};

async function setupPublicService() {
    const ctx = await setupTestApp(StoryService);
    applyStoryMigration(ctx.sqlite);
    await createTestUser(ctx.sqlite);
    return ctx;
}

async function setupAdminService() {
    const ctx = await setupTestApp(AdminStoryService);
    applyStoryMigration(ctx.sqlite);
    await createTestUser(ctx.sqlite);
    return ctx;
}

function seedLegacyFeed(sqlite: Database, overrides: Record<string, string | number> = {}) {
    const row = {
        alias: 'legacy-post',
        title: 'Legacy Post',
        content: '# hello legacy',
        uid: 1,
        draft: 0,
        listed: 1,
        ...overrides,
    };
    sqlite.exec(
        `INSERT INTO feeds (alias, title, content, uid, draft, listed) VALUES ('${row.alias}', '${row.title}', '${row.content}', ${row.uid}, ${row.draft}, ${row.listed})`
    );
    return sqlite.query('SELECT id FROM feeds WHERE alias = ?').get(row.alias) as { id: number };
}

async function seedStory(db: any, slug = 'my-story', status: 'published' | 'draft' = 'published') {
    const inserted = await insertStory(db, {
        slug,
        title: 'My Story',
        status,
        summary: 'sum',
        coverAssetId: null,
        feedId: null,
        publishedAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date(),
        verifiedAt: null,
    });
    await insertStoryBlocks(db, inserted!.insertedId, [
        { type: 'rich_text', payload: { markdown: '# story body' } },
    ]);
    return inserted!.insertedId;
}

describe('StoryService (public read)', () => {
    let app: Hono<{ Bindings: Env; Variables: Variables }>;
    let db: any;
    let sqlite: Database;
    let env: Env;

    beforeEach(async () => {
        const ctx = await setupPublicService();
        app = ctx.app; db = ctx.db; sqlite = ctx.sqlite; env = ctx.env;
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });

    it('returns 404 when neither stories.slug nor feeds.alias matches', async () => {
        const res = await app.request('/nope', { method: 'GET' }, env);
        expect(res.status).toBe(404);
    });

    it('falls back to feeds.alias and synthesizes a single rich_text block view', async () => {
        const { id } = seedLegacyFeed(sqlite);

        const res = await app.request('/legacy-post', { method: 'GET' }, env);
        expect(res.status).toBe(200);
        const data = await res.json() as any;

        expect(data.fromLegacyFeed).toBe(true);
        expect(data.feedId).toBe(id);
        expect(data.slug).toBe('legacy-post');
        expect(data.title).toBe('Legacy Post');
        expect(data.blocks).toHaveLength(1);
        expect(data.blocks[0].type).toBe('rich_text');
        expect(JSON.parse(data.blocks[0].payloadJson)).toEqual({ markdown: '# hello legacy' });
    });

    it('hides draft legacy feeds from anonymous readers (403)', async () => {
        seedLegacyFeed(sqlite, { alias: 'draft-post', draft: 1 });

        const res = await app.request('/draft-post', { method: 'GET' }, env);
        expect(res.status).toBe(403);
    });

    it('prefers stories.slug over feeds.alias on collision', async () => {
        seedLegacyFeed(sqlite, { alias: 'shared-slug', content: '# legacy content' });
        await seedStory(db, 'shared-slug', 'published');

        const res = await app.request('/shared-slug', { method: 'GET' }, env);
        expect(res.status).toBe(200);
        const data = await res.json() as any;

        expect(data.fromLegacyFeed ?? false).toBe(false);
        expect(data.title).toBe('My Story');
        expect(JSON.parse(data.blocks[0].payloadJson)).toEqual({ markdown: '# story body' });
    });

    it('serves a native story with its ordered blocks', async () => {
        await seedStory(db, 'native', 'published');

        const res = await app.request('/native', { method: 'GET' }, env);
        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.slug).toBe('native');
        expect(data.status).toBe('published');
        expect(data.blocks).toHaveLength(1);
        expect(data.publishedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('hides draft stories from anonymous readers but shows them to admin', async () => {
        await seedStory(db, 'draft-story', 'draft');

        const anon = await app.request('/draft-story', { method: 'GET' }, env);
        expect(anon.status).toBe(403);

        const adminRes = await app.request('/draft-story', {
            method: 'GET',
            headers: { 'Authorization': 'Bearer mock_token_1' },
        }, env);
        expect(adminRes.status).toBe(200);
    });
});

describe('AdminStoryService', () => {
    let app: Hono<{ Bindings: Env; Variables: Variables }>;
    let db: any;
    let sqlite: Database;
    let env: Env;

    beforeEach(async () => {
        const ctx = await setupAdminService();
        app = ctx.app; db = ctx.db; sqlite = ctx.sqlite; env = ctx.env;
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });

    it('returns 401 for unauthenticated admin requests', async () => {
        for (const [method, path, body] of [
            ['GET', '/', undefined],
            ['POST', '/', JSON.stringify({ slug: 'x' })],
            ['GET', '/1', undefined],
            ['PUT', '/1', JSON.stringify({ title: 'x' })],
            ['DELETE', '/1', undefined],
        ] as const) {
            const res = await app.request(path, {
                method,
                headers: body ? { 'Content-Type': 'application/json' } : undefined,
                body,
            }, env);
            expect(res.status).toBe(401);
        }
    });

    it('creates a story with blocks (201)', async () => {
        const res = await app.request('/', {
            method: 'POST',
            headers: ADMIN_HEADERS,
            body: JSON.stringify({
                slug: 'new-story',
                title: 'New Story',
                status: 'published',
                summary: 's',
                blocks: [
                    { type: 'rich_text', payload: { markdown: '# hi' } },
                    { type: 'divider', payload: {} },
                ],
            }),
        }, env);

        expect(res.status).toBe(201);
        const data = await res.json() as any;
        expect(data.slug).toBe('new-story');
        expect(data.blocks).toHaveLength(2);
        expect(data.blocks[0].type).toBe('rich_text');
        expect(data.blocks[0].position).toBe(0);
        expect(data.blocks[1].type).toBe('divider');
    });

    it('rejects invalid bodies (400): missing slug, bad status, bad block type, duplicate slug', async () => {
        const missingSlug = await app.request('/', {
            method: 'POST', headers: ADMIN_HEADERS,
            body: JSON.stringify({ title: 'No Slug' }),
        }, env);
        expect(missingSlug.status).toBe(400);

        const badStatus = await app.request('/', {
            method: 'POST', headers: ADMIN_HEADERS,
            body: JSON.stringify({ slug: 's1', status: 'flying' }),
        }, env);
        expect(badStatus.status).toBe(400);

        const badBlock = await app.request('/', {
            method: 'POST', headers: ADMIN_HEADERS,
            body: JSON.stringify({ slug: 's2', blocks: [{ type: 'spaceship', payload: {} }] }),
        }, env);
        expect(badBlock.status).toBe(400);

        await app.request('/', {
            method: 'POST', headers: ADMIN_HEADERS,
            body: JSON.stringify({ slug: 'dup' }),
        }, env);
        const dup = await app.request('/', {
            method: 'POST', headers: ADMIN_HEADERS,
            body: JSON.stringify({ slug: 'dup' }),
        }, env);
        expect(dup.status).toBe(400);
    });

    it('lists stories with pagination', async () => {
        await seedStory(db, 'a-1');
        await seedStory(db, 'a-2');
        await seedStory(db, 'a-3');

        const res = await app.request('/?page=1&limit=2', { method: 'GET', headers: ADMIN_HEADERS }, env);
        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.size).toBe(3);
        expect(data.data).toHaveLength(2);
        expect(data.hasNext).toBe(true);
    });

    it('gets a story by id for admin', async () => {
        const id = await seedStory(db, 'detail');

        const res = await app.request(`/${id}`, { method: 'GET', headers: ADMIN_HEADERS }, env);
        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.slug).toBe('detail');

        const missing = await app.request('/9999', { method: 'GET', headers: ADMIN_HEADERS }, env);
        expect(missing.status).toBe(404);
    });

    it('updates a story and replaces its blocks', async () => {
        const id = await seedStory(db, 'to-update');

        const res = await app.request(`/${id}`, {
            method: 'PUT',
            headers: ADMIN_HEADERS,
            body: JSON.stringify({
                title: 'Updated Title',
                status: 'updated',
                blocks: [{ type: 'quote', payload: { text: 'q' } }],
            }),
        }, env);
        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.title).toBe('Updated Title');
        expect(data.status).toBe('updated');
        expect(data.slug).toBe('to-update');
        expect(data.blocks).toHaveLength(1);
        expect(data.blocks[0].type).toBe('quote');
    });

    it('rejects slug collision on update (400) and 404 on unknown id', async () => {
        const idA = await seedStory(db, 'story-a');
        await seedStory(db, 'story-b');

        const collision = await app.request(`/${idA}`, {
            method: 'PUT', headers: ADMIN_HEADERS,
            body: JSON.stringify({ slug: 'story-b' }),
        }, env);
        expect(collision.status).toBe(400);

        const missing = await app.request('/9999', {
            method: 'PUT', headers: ADMIN_HEADERS,
            body: JSON.stringify({ title: 'x' }),
        }, env);
        expect(missing.status).toBe(404);
    });

    it('deletes a story and its blocks', async () => {
        const id = await seedStory(db, 'to-delete');

        const res = await app.request(`/${id}`, { method: 'DELETE', headers: ADMIN_HEADERS }, env);
        expect(res.status).toBe(200);

        const gone = await app.request(`/${id}`, { method: 'GET', headers: ADMIN_HEADERS }, env);
        expect(gone.status).toBe(404);

        const remaining = sqlite.query('SELECT COUNT(*) AS n FROM content_blocks').get() as { n: number };
        expect(remaining.n).toBe(0);
    });
});
