import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { CommentService } from '../comments';
import { Hono } from "hono";
import type { Variables } from "../../core/hono-types";
import { setupTestApp, cleanupTestDB } from '../../../tests/fixtures';
import type { Database } from 'bun:sqlite';

describe('CommentService', () => {
    let db: any;
    let sqlite: Database;
    let env: Env;
    let app: Hono<{ Bindings: Env; Variables: Variables }>;
    const originalFetch = globalThis.fetch;

    beforeEach(async () => {
        const ctx = await setupTestApp(CommentService);
        db = ctx.db;
        sqlite = ctx.sqlite;
        env = ctx.env;
        app = ctx.app;
        
        // Seed test data
        await seedTestData(sqlite);
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        cleanupTestDB(sqlite);
    });

    async function seedTestData(sqlite: Database) {
        // Insert test users
        sqlite.exec(`
            INSERT INTO users (id, username, avatar, permission, openid) VALUES 
                (1, 'user1', 'avatar1.png', 0, 'gh_1'),
                (2, 'user2', 'avatar2.png', 0, 'gh_2'),
                (3, 'admin', 'admin.png', 1, 'gh_admin')
        `);

        // Insert test feeds
        sqlite.exec(`
            INSERT INTO feeds (id, title, content, uid, draft, listed) VALUES 
                (1, 'Feed 1', 'Content 1', 1, 0, 1),
                (2, 'Feed 2', 'Content 2', 1, 0, 1)
        `);

        // Insert test comments
        sqlite.exec(`
            INSERT INTO comments (id, feed_id, user_id, content, created_at) VALUES 
                (1, 1, 2, 'Comment 1 on feed 1', unixepoch()),
                (2, 1, 2, 'Comment 2 on feed 1', unixepoch()),
                (3, 2, 1, 'Comment on feed 2', unixepoch())
        `);
    }

    describe('GET /:feed - List comments', () => {
        it('should return comments for a feed', async () => {
            const res = await app.request('/1', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data).toBeArray();
            expect(data.length).toBe(2);
            expect(data[0]).toHaveProperty('content');
            expect(data[0]).toHaveProperty('user');
            expect(data[0].user).toHaveProperty('username');
        });

        it('should return empty array when feed has no comments', async () => {
            // Create new feed without comments
            sqlite.exec(`INSERT INTO feeds (id, title, content, uid) VALUES (3, 'No Comments', 'Content', 1)`);
            
            const res = await app.request('/3', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data).toEqual([]);
        });

        it('should not expose sensitive fields', async () => {
            const res = await app.request('/1', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.length).toBeGreaterThan(0);
            
            // Should not include feedId and userId (excluded in query)
            expect(data[0]).not.toHaveProperty('feedId');
            expect(data[0]).not.toHaveProperty('userId');
            
            // Should include user info
            expect(data[0].user).toHaveProperty('id');
            expect(data[0].user).toHaveProperty('username');
            expect(data[0].user).toHaveProperty('avatar');
            expect(data[0].user).toHaveProperty('permission');
        });

        it('should order comments by createdAt descending', async () => {
            const res = await app.request('/1', { method: 'GET' }, env);
            
            expect(res.status).toBe(200);
            const data = await res.json() as any;
            expect(data.length).toBe(2);
        });
    });

    describe('POST /:feed - Create comment', () => {
        it('should create comment with authenticated user', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: 'New test comment' }),
            }, env);

            expect(res.status).toBe(200);
            
            // Verify comment was created
            const comments = sqlite.prepare(`SELECT * FROM comments WHERE feed_id = 1`).all();
            expect(comments.length).toBe(3);
        });

        it('should create guest comment with guestName', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: 'Guest comment',
                    guestName: 'Visitor',
                    guestEmail: 'visitor@example.com',
                    guestWebsite: 'https://example.com',
                }),
            }, env);

            expect(res.status).toBe(200);

            // Verify via direct DB query
            const row = sqlite.prepare(
                `SELECT content, guest_name, guest_email, guest_website FROM comments WHERE guest_name = 'Visitor'`
            ).get() as any;
            expect(row).toBeDefined();
            expect(row.content).toBe('Guest comment');
            expect(row.guest_name).toBe('Visitor');
            expect(row.guest_email).toBe('visitor@example.com');
            expect(row.guest_website).toBe('https://example.com');
        });

        it('should reject guest comment without guestName', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'Guest no name' }),
            }, env);
            expect(res.status).toBe(400);
        });

        it('should return guest comments with user: null in list', async () => {
            // Create a guest comment first
            const createRes = await app.request('/1', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'Hi from guest', guestName: 'Guest' }),
            }, env);
            expect(createRes.status).toBe(200);

            const res = await app.request('/1', { method: 'GET' }, env);
            expect(res.status).toBe(200);
            const data = await res.json() as any[];
            const guestComment = data.find((c: any) => c.guestName === 'Guest');
            expect(guestComment).toBeDefined();
            expect(guestComment.user).toBeNull();
            expect(guestComment.content).toBe('Hi from guest');
        });

        it('should return 400 when not authenticated and guest name missing', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'Test comment' }),
            }, env);

            expect(res.status).toBe(400);
            expect(await res.text()).toContain('Guest name is required');
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

        it('should return 401 for non-existent user token', async () => {
            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_999',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: 'Test' }),
            }, env);

            expect(res.status).toBe(400);
        });

        it('should return 400 for non-existent feed', async () => {
            const res = await app.request('/999', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: 'Test' }),
            }, env);

            expect(res.status).toBe(400);
        });

        it('should still create the comment when webhook delivery fails', async () => {
            env.WEBHOOK_URL = 'not-a-valid-url' as any;
            globalThis.fetch = mock(async () => {
                throw new TypeError('Invalid URL');
            }) as typeof fetch;

            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: 'Comment survives webhook errors' }),
            }, env);

            expect(res.status).toBe(200);

            const comments = sqlite.prepare(`SELECT * FROM comments WHERE feed_id = 1`).all();
            expect(comments.length).toBe(3);
        });
    });

    describe('Comment location (IP2REGION)', () => {
        function ip2regionBinding(body: unknown) {
            return {
                fetch: mock(async () => new Response(JSON.stringify(body), { status: 200 })),
            } as unknown as Fetcher;
        }

        it('stores ip and resolved location for guest comments', async () => {
            const binding = ip2regionBinding({
                country: '中国', province: '江苏省', city: '南京市', isp: '电信',
            });
            env.IP2REGION = binding;

            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'CF-Connecting-IP': '114.114.114.114',
                    'CF-IPCountry': 'CN',
                },
                body: JSON.stringify({ content: 'Guest from Nanjing', guestName: 'Nanjinger' }),
            }, env);

            expect(res.status).toBe(200);
            const row = sqlite.prepare(
                `SELECT ip, location, country, province, city FROM comments WHERE guest_name = 'Nanjinger'`
            ).get() as any;
            expect(row.ip).toBe('114.114.114.114');
            expect(row.location).toBe('江苏省·南京市');
            expect(row.country).toBe('中国');
            expect(row.province).toBe('江苏省');
            expect(row.city).toBe('南京市');
        });

        it('stores location for authenticated comments too', async () => {
            env.IP2REGION = ip2regionBinding({ country: '中国', province: '广东省', city: '深圳市' });

            const res = await app.request('/2', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer mock_token_1',
                    'Content-Type': 'application/json',
                    'CF-Connecting-IP': '223.5.5.5',
                },
                body: JSON.stringify({ content: 'Logged in comment' }),
            }, env);

            expect(res.status).toBe(200);
            const row = sqlite.prepare(
                `SELECT ip, location FROM comments WHERE content = 'Logged in comment'`
            ).get() as any;
            expect(row.ip).toBe('223.5.5.5');
            expect(row.location).toBe('广东省·深圳市');
        });

        it('falls back to x-real-ip and CF-IPCountry when the binding is missing', async () => {
            delete (env as any).IP2REGION;

            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Real-IP': '8.8.8.8',
                    'CF-IPCountry': 'US',
                },
                body: JSON.stringify({ content: 'Hello', guestName: 'Abroad' }),
            }, env);

            expect(res.status).toBe(200);
            const row = sqlite.prepare(
                `SELECT ip, location, country, province FROM comments WHERE guest_name = 'Abroad'`
            ).get() as any;
            expect(row.ip).toBe('8.8.8.8');
            expect(row.location).toBe('美国');
            expect(row.province).toBe('');
        });

        it('still creates the comment when the binding fails', async () => {
            env.IP2REGION = {
                fetch: mock(async () => {
                    throw new Error('VPC service unreachable');
                }),
            } as unknown as Fetcher;

            const res = await app.request('/1', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'CF-Connecting-IP': '114.114.114.114',
                    'CF-IPCountry': 'CN',
                },
                body: JSON.stringify({ content: 'Survives geo failure', guestName: 'Resilient' }),
            }, env);

            expect(res.status).toBe(200);
            const row = sqlite.prepare(
                `SELECT location FROM comments WHERE guest_name = 'Resilient'`
            ).get() as any;
            expect(row.location).toBe('中国');
        });

        it('never exposes the raw ip to anonymous visitors', async () => {
            sqlite.exec(`UPDATE comments SET ip = '114.114.114.114', location = '江苏省·南京市' WHERE id = 1`);

            const res = await app.request('/1', { method: 'GET' }, env);
            const data = await res.json() as any[];

            expect(data.length).toBeGreaterThan(0);
            for (const comment of data) {
                expect(comment).not.toHaveProperty('ip');
            }
            expect(data.some((c) => c.location === '江苏省·南京市')).toBe(true);
        });

        it('does not expose the raw ip to a non-admin logged-in user', async () => {
            sqlite.exec(`UPDATE comments SET ip = '114.114.114.114' WHERE id = 1`);

            const res = await app.request('/1', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer mock_token_2' },
            }, env);
            const data = await res.json() as any[];

            for (const comment of data) {
                expect(comment).not.toHaveProperty('ip');
            }
        });

        it('exposes the raw ip to admins', async () => {
            sqlite.exec(`UPDATE comments SET ip = '114.114.114.114' WHERE id = 1`);

            const res = await app.request('/1', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer mock_token_3' },
            }, env);
            const data = await res.json() as any[];

            const target = data.find((c) => c.id === 1);
            expect(target.ip).toBe('114.114.114.114');
        });
    });

    describe('DELETE /:id - Delete comment', () => {
        it('should allow user to delete their own comment', async () => {
            const res = await app.request('/1', {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_2' },
            }, env);

            expect(res.status).toBe(200);
            
            // Verify comment was deleted
            const dbResult = sqlite.prepare(`SELECT * FROM comments WHERE id = 1`).all();
            expect(dbResult.length).toBe(0);
        });

        it('should allow admin to delete any comment', async () => {
            const res = await app.request('/1', {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_3' },
            }, env);

            expect(res.status).toBe(200);
        });

        it('should deny deletion by other users', async () => {
            const res = await app.request('/1', {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);

            expect(res.status).toBe(403);
        });

        it('should require authentication', async () => {
            const res = await app.request('/1', { method: 'DELETE' }, env);

            expect(res.status).toBe(401);
        });

        it('should return 404 for non-existent comment', async () => {
            const res = await app.request('/999', {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer mock_token_1' },
            }, env);

            expect(res.status).toBe(404);
        });
    });
});
