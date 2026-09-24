import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MomentsService } from '../moments';
import { Hono } from "hono";
import type { Variables } from "../../core/hono-types";
import { setupTestApp, cleanupTestDB } from '../../../tests/fixtures';
import type { Database } from 'bun:sqlite';
import type { TestCacheImpl } from '../../../tests/fixtures';

describe('MomentsService', () => {
    let db: any;
    let sqlite: Database;
    let env: Env;
    let app: Hono<{ Bindings: Env; Variables: Variables }>;
    let cache: TestCacheImpl;
    let clientConfig: TestCacheImpl;

    beforeEach(async () => {
        const ctx = await setupTestApp(MomentsService);
        db = ctx.db;
        sqlite = ctx.sqlite;
        env = ctx.env;
        app = ctx.app;
        cache = ctx.cache;
        clientConfig = ctx.clientConfig;

        // Create test users
        await createTestUsers();
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });

    async function createTestUsers() {
        sqlite.exec(`
            INSERT INTO users (id, username, openid, avatar, permission) 
            VALUES (1, 'admin', 'gh_admin', 'admin.png', 1)
        `);
        sqlite.exec(`
            INSERT INTO users (id, username, openid, avatar, permission) 
            VALUES (2, 'regular', 'gh_regular', 'regular.png', 0)
        `);
    }

    describe('GET / - List moments', () => {
        it('should return empty list when no moments exist', async () => {
            const res = await app.request('/', { method: 'GET' }, env);

            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.data).toEqual([]);
            expect(data.hasNext).toBe(false);
            expect(data.size).toBe(0);
        });

        it('should return paginated moments', async () => {
            sqlite.exec(`
                INSERT INTO moments (id, content, uid, created_at, updated_at) VALUES 
                (1, 'Moment 1', 1, unixepoch(), unixepoch()),
                (2, 'Moment 2', 1, unixepoch(), unixepoch()),
                (3, 'Moment 3', 1, unixepoch(), unixepoch())
            `);

            const res = await app.request('/?page=1&limit=2', { method: 'GET' }, env);

            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.data.length).toBe(2);
            expect(data.hasNext).toBe(true);
            expect(data.size).toBe(3);
        });

        it('should limit to maximum 50 items per page', async () => {
            const values = Array.from({ length: 55 }, (_, i) =>
                `(${i + 1}, 'Moment ${i + 1}', 1, unixepoch(), unixepoch())`
            ).join(',');
            sqlite.exec(`INSERT INTO moments (id, content, uid, created_at, updated_at) VALUES ${values}`);

            const res = await app.request('/?page=1&limit=100', { method: 'GET' }, env);

            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.data.length).toBeLessThanOrEqual(50);
        });

        it('should order moments by createdAt descending', async () => {
            sqlite.exec(`
                INSERT INTO moments (id, content, uid, created_at, updated_at) VALUES 
                (1, 'Oldest', 1, unixepoch() - 100, unixepoch()),
                (2, 'Middle', 1, unixepoch() - 50, unixepoch()),
                (3, 'Newest', 1, unixepoch(), unixepoch())
            `);

            const res = await app.request('/', { method: 'GET' }, env);

            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.data[0].content).toBe('Newest');
            expect(data.data[2].content).toBe('Oldest');
        });

        it('should bypass stale public cache when cache is disabled', async () => {
            await clientConfig.set('cache.enabled', false);
            await cache.set('moments_0_20', {
                size: 1,
                data: [{ id: 999, content: 'Stale moment' }],
                hasNext: false,
            });

            sqlite.exec(`
                INSERT INTO moments (id, content, uid, created_at, updated_at) VALUES 
                (1, 'Fresh moment', 1, unixepoch(), unixepoch())
            `);

            const res = await app.request('/', { method: 'GET' }, env);

            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.data[0].content).toBe('Fresh moment');
        });
    });

    describe('POST / - Create moment', () => {
        it('should require authentication', async () => {
            const res = await app.request('/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'Test moment' }),
            }, env);

            expect(res.status).toBe(401);
        });

        it('should allow admin to create moment', async () => {
            const res = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: 'Test moment content' }),
            }, env);

            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.insertedId).toBeNumber();
        });

        it('should require content', async () => {
            const res = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: '' }),
            }, env);

            expect(res.status).toBe(400);
        });

        it('does not auto-bind media when creating a moment', async () => {
            // syncMediaForMoment 已随旧媒体模型下线：写动态不再自动绑定/释放资产。
            // 资产只通过 media_assets.moment_id 显式关联，删除动态时由外键置空。
            sqlite.exec(`
                INSERT INTO media_assets (kind, source, r2_key, mime)
                VALUES ('image', 'r2', 'media/1/image-1.png', 'image/png')
            `);

            const res = await app.request('/', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: '![cover](https://example.com/api/media/image-1/playback)' }),
            }, env);

            expect(res.status).toBe(200);
            const { insertedId } = await res.json() as any;
            expect(insertedId).toBeGreaterThan(0);
            const asset = sqlite.query('SELECT moment_id FROM media_assets WHERE r2_key = ?').get('media/1/image-1.png') as any;
            expect(asset.moment_id).toBeNull();
        });
    });

    describe('POST /:id - Update moment', () => {
        beforeEach(() => {
            sqlite.exec(`
                INSERT INTO moments (id, content, uid, created_at, updated_at) VALUES 
                (1, 'Original content', 1, unixepoch(), unixepoch())
            `);
        });

        it('should require authentication', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'Updated content' }),
            }, env);

            expect(res.status).toBe(401);
        });

        it('should allow admin to update moment', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: 'Updated content' }),
            }, env);

            expect(res.status).toBe(200);
        });

        it('does not touch media bindings when editing a moment', async () => {
            // syncMediaForMoment 已随旧媒体模型下线：编辑动态不再自动释放资产。
            sqlite.exec(`
                INSERT INTO media_assets (kind, source, r2_key, mime, moment_id)
                VALUES ('image', 'r2', 'media/1/image-1.png', 'image/png', 1)
            `);

            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: 'No media here anymore' }),
            }, env);

            expect(res.status).toBe(200);
            const asset = sqlite.query('SELECT moment_id FROM media_assets WHERE r2_key = ?').get('media/1/image-1.png') as any;
            expect(asset.moment_id).toBe(1);
        });

        it('should return 404 for non-existent moment', async () => {
            const res = await app.request('/999', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: 'Updated content' }),
            }, env);

            expect(res.status).toBe(404);
        });

        it('should require content', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: '' }),
            }, env);

            expect(res.status).toBe(400);
        });
    });

    describe('DELETE /:id - Delete moment', () => {
        beforeEach(() => {
            sqlite.exec(`
                INSERT INTO moments (id, content, uid, created_at, updated_at) VALUES 
                (1, 'Moment to delete', 1, unixepoch(), unixepoch())
            `);
        });

        it('should require authentication', async () => {
            const res = await app.request('/1', { method: 'DELETE' }, env);

            expect(res.status).toBe(401);
        });

        it('should allow admin to delete moment', async () => {
            const res = await app.request('/1', {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);

            expect(res.status).toBe(200);

            // Verify deletion
            const moment = sqlite.prepare('SELECT * FROM moments WHERE id = 1').get();
            expect(moment).toBeNull();
        });

        it('does not touch media bindings when editing a moment', async () => {
            // syncMediaForMoment 已随旧媒体模型下线：编辑动态不再自动释放资产。
            sqlite.exec(`
                INSERT INTO media_assets (kind, source, r2_key, mime, moment_id)
                VALUES ('image', 'r2', 'media/1/image-1.png', 'image/png', 1)
            `);

            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: 'No media here anymore' }),
            }, env);

            expect(res.status).toBe(200);
            const asset = sqlite.query('SELECT moment_id FROM media_assets WHERE r2_key = ?').get('media/1/image-1.png') as any;
            expect(asset.moment_id).toBe(1);
        });

        it('should release media used by the deleted moment', async () => {
            sqlite.exec(`
                INSERT INTO media_assets (kind, source, r2_key, mime, moment_id)
                VALUES ('image', 'r2', 'media/1/image-1.png', 'image/png', 1)
            `);

            const res = await app.request('/1', {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);

            expect(res.status).toBe(200);
            const asset = sqlite.query('SELECT moment_id FROM media_assets WHERE r2_key = ?').get('media/1/image-1.png') as any;
            expect(asset.moment_id).toBeNull();
        });

        it('should return 404 for non-existent moment', async () => {
            const res = await app.request('/999', {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);

            expect(res.status).toBe(404);
        });
    });
});
