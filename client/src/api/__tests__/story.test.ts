import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { createClient } from '../client'
import type { StoryDetailResponse, StoryListResponse } from '../story'

const api = createClient('http://localhost')

// Mock fetch globally
const mockFetch = mock()
global.fetch = mockFetch

const mockResponse = <T extends object>(response: T) => ({
  ...response,
  clone() {
    return this
  },
})

// 后端实际返回的 wire 形状（扁平 camelCase）
const wireStoryDetail = {
  id: 1,
  slug: 'hello-story',
  title: 'Hello Story',
  status: 'published',
  summary: 'A summary',
  coverAssetId: null,
  feedId: null,
  publishedAt: '2026-09-24T00:00:00.000Z',
  updatedAt: '2026-09-24T01:00:00.000Z',
  verifiedAt: null,
  blocks: [
    { id: 1, storyId: 1, type: 'rich_text', position: 0, payloadJson: '{"markdown":"# Hi"}', revision: 1 },
    { id: 2, storyId: 1, type: 'video', position: 1, payloadJson: '{"title":"Talk"}', revision: 1 },
  ],
}

const expectedDetail: StoryDetailResponse = {
  story: {
    id: 1,
    slug: 'hello-story',
    title: 'Hello Story',
    summary: 'A summary',
    status: 'published',
    published_at: '2026-09-24T00:00:00.000Z',
    updated_at: '2026-09-24T01:00:00.000Z',
    verified_at: undefined,
  },
  blocks: [
    { id: 1, type: 'rich_text', position: 0, payload: { markdown: '# Hi' } },
    { id: 2, type: 'video', position: 1, payload: { title: 'Talk' } },
  ],
  assets: [],
  relations: [],
}

const wireStoryList = {
  size: 1,
  data: [wireStoryDetail],
  hasNext: false,
}

const expectedList: StoryListResponse = {
  stories: [
    {
      id: 1,
      slug: 'hello-story',
      title: 'Hello Story',
      summary: 'A summary',
      status: 'published',
      updated_at: '2026-09-24T01:00:00.000Z',
    },
  ],
  total: 1,
}

describe('Story API', () => {
  beforeEach(() => {
    mockFetch.mockClear()
  })

  it('should fetch a story by slug and adapt the wire shape', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => wireStoryDetail,
      })
    )

    const result = await api.story.get('hello-story')

    expect(result.data).toEqual(expectedDetail)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/story/hello-story'),
      expect.any(Object)
    )
  })

  it('should list stories with status filter against the admin endpoint', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => wireStoryList,
      })
    )

    const result = await api.story.list({ page: 1, limit: 20, status: 'published' })

    expect(result.data).toEqual(expectedList)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/stories?page=1&limit=20&status=published'),
      expect.any(Object)
    )
  })

  it('should create a story via the admin endpoint and return insertedId', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ ...wireStoryDetail, id: 42 }),
      })
    )

    const result = await api.story.create({
      slug: 'new-story',
      title: 'New Story',
      status: 'draft',
      blocks: [{ type: 'rich_text', position: 0, payload: { markdown: 'hi' } }],
    })

    expect(result.data).toEqual({ insertedId: 42 })
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/stories'),
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('should update a story', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({}),
      })
    )

    const result = await api.story.update(1, { title: 'Renamed' })

    expect(result.error).toBeUndefined()
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/stories/1'),
      expect.objectContaining({ method: 'PUT' })
    )
  })

  it('should delete a story', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({}),
      })
    )

    const result = await api.story.remove(1)

    expect(result.error).toBeUndefined()
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/stories/1'),
      expect.objectContaining({ method: 'DELETE' })
    )
  })

  it('should surface a 404 error value', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ error: 'Not found' }),
      })
    )

    const result = await api.story.get('missing')

    expect(result.error?.status).toBe(404)
    expect(result.error?.value).toBe('Not found')
  })
})
