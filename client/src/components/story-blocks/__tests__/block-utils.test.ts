import { describe, expect, it } from 'bun:test'
import {
  createBlock,
  formatDuration,
  kindForMime,
  mediaTabsForBlocks,
  moveBlock,
  removeBlock,
  updateBlockPayload,
} from '../block-utils'
import type { ContentBlock } from '../../../api/story'

const text = (id: string, position: number): ContentBlock => ({
  id, type: 'rich_text', position, payload: { markdown: 'hi' },
})

describe('mediaTabsForBlocks', () => {
  it('shows only the read tab when there are only rich_text blocks', () => {
    expect(mediaTabsForBlocks([text('a', 0), text('b', 1)])).toEqual(['read'])
  })

  it('always includes the read tab, even with no blocks', () => {
    expect(mediaTabsForBlocks([])).toEqual(['read'])
  })

  it('adds the video tab only when a video block exists', () => {
    expect(
      mediaTabsForBlocks([text('a', 0), { id: 'v', type: 'video', position: 1, payload: {} }])
    ).toEqual(['read', 'video'])
  })

  it('adds the audio tab only when an audio block exists', () => {
    expect(
      mediaTabsForBlocks([{ id: 'a', type: 'audio', position: 0, payload: {} }])
    ).toEqual(['read', 'audio'])
  })

  it('keeps canonical order read -> video -> audio', () => {
    expect(
      mediaTabsForBlocks([
        { id: 'a', type: 'audio', position: 0, payload: {} },
        { id: 'v', type: 'video', position: 1, payload: {} },
      ])
    ).toEqual(['read', 'video', 'audio'])
  })

  it('maps gallery/image blocks to the read tab', () => {
    expect(
      mediaTabsForBlocks([{ id: 'g', type: 'gallery', position: 0, payload: {} }])
    ).toEqual(['read'])
  })
})

describe('createBlock', () => {
  it('creates a rich_text block with an empty markdown payload', () => {
    const block = createBlock('rich_text', 2)
    expect(block.type).toBe('rich_text')
    expect(block.position).toBe(2)
    expect(block.payload).toEqual({ markdown: '' })
    expect(typeof block.id).toBe('string')
  })

  it('creates an image block with an empty payload', () => {
    const block = createBlock('image', 0)
    expect(block.type).toBe('image')
    expect(block.position).toBe(0)
    expect(block.payload).toEqual({})
    expect(typeof block.id).toBe('string')
  })

  it('generates unique ids', () => {
    expect(createBlock('video', 0).id).not.toBe(createBlock('video', 0).id)
  })
})

describe('moveBlock', () => {
  const blocks = [text('a', 0), text('b', 1), text('c', 2)]

  it('moves a block up and re-indexes positions', () => {
    const next = moveBlock(blocks, 1, -1)
    expect(next.map((b) => b.id)).toEqual(['b', 'a', 'c'])
    expect(next.map((b) => b.position)).toEqual([0, 1, 2])
  })

  it('moves a block down', () => {
    const next = moveBlock(blocks, 0, 1)
    expect(next.map((b) => b.id)).toEqual(['b', 'a', 'c'])
  })

  it('is a no-op at the boundaries', () => {
    expect(moveBlock(blocks, 0, -1)).toBe(blocks)
    expect(moveBlock(blocks, 2, 1)).toBe(blocks)
  })

  it('does not mutate the input', () => {
    moveBlock(blocks, 1, -1)
    expect(blocks.map((b) => b.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('removeBlock', () => {
  it('removes by id and re-indexes positions', () => {
    const next = removeBlock([text('a', 0), text('b', 1), text('c', 2)], 'b')
    expect(next.map((b) => b.id)).toEqual(['a', 'c'])
    expect(next.map((b) => b.position)).toEqual([0, 1])
  })
})

describe('updateBlockPayload', () => {
  it('merges the patch into the matching block payload', () => {
    const next = updateBlockPayload([text('a', 0)], 'a', { markdown: '# new' })
    expect(next[0].payload).toEqual({ markdown: '# new' })
  })

  it('leaves other blocks untouched', () => {
    const next = updateBlockPayload([text('a', 0), text('b', 1)], 'a', { markdown: 'x' })
    expect(next[1].payload).toEqual({ markdown: 'hi' })
  })
})

describe('formatDuration', () => {
  it('formats seconds as m:ss', () => {
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(0)).toBe('0:00')
  })

  it('formats long durations as h:mm:ss', () => {
    expect(formatDuration(3725)).toBe('1:02:05')
  })

  it('returns an em dash for missing values', () => {
    expect(formatDuration(undefined)).toBe('—')
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(NaN)).toBe('—')
    expect(formatDuration(-1)).toBe('—')
  })
})

describe('kindForMime', () => {
  it('maps mime prefixes to picker kinds', () => {
    expect(kindForMime('image/png')).toBe('image')
    expect(kindForMime('video/mp4')).toBe('video')
    expect(kindForMime('audio/mpeg')).toBe('audio')
    expect(kindForMime('application/pdf')).toBeUndefined()
  })
})
