import { describe, expect, it } from 'bun:test'
import {
  audioProgressKey,
  findChapterIndex,
  parseStoredProgress,
  responsiveImageProps,
  shouldPersistProgress,
  AUDIO_PROGRESS_SAVE_INTERVAL_MS,
} from '../block-utils'

describe('responsiveImageProps', () => {
  const variants = {
    thumb: 'https://images.example.com/x/thumb',
    medium: 'https://images.example.com/x/medium',
    large: 'https://images.example.com/x/large',
  }

  it('builds a width-descriptor srcSet from thumb/medium/large variants', () => {
    const props = responsiveImageProps({ url: 'https://images.example.com/x', images_variants: variants })
    expect(props.srcSet).toBe(
      'https://images.example.com/x/thumb 320w, ' +
      'https://images.example.com/x/medium 960w, ' +
      'https://images.example.com/x/large 1600w',
    )
  })

  it('prefers the medium variant as the default src and large as the lightbox src', () => {
    const props = responsiveImageProps({ url: 'https://images.example.com/x', images_variants: variants })
    expect(props.src).toBe('https://images.example.com/x/medium')
    expect(props.largeSrc).toBe('https://images.example.com/x/large')
  })

  it('falls back to the plain url when there are no variants', () => {
    const props = responsiveImageProps({ url: 'https://cdn.example.com/a.jpg' })
    expect(props.src).toBe('https://cdn.example.com/a.jpg')
    expect(props.srcSet).toBeUndefined()
    expect(props.largeSrc).toBeUndefined()
  })

  it('falls back to the url when the variants object is empty or unusable', () => {
    expect(responsiveImageProps({ url: 'https://cdn.example.com/a.jpg', images_variants: {} }).src).toBe(
      'https://cdn.example.com/a.jpg',
    )
    expect(responsiveImageProps(undefined).src).toBe('')
  })

  it('matches variant names case-insensitively and tolerates aliases', () => {
    const props = responsiveImageProps({
      url: 'https://cdn.example.com/a.jpg',
      images_variants: { Thumbnail: 'https://images.example.com/x/t', Medium: 'https://images.example.com/x/m' },
    })
    expect(props.srcSet).toBe('https://images.example.com/x/t 320w, https://images.example.com/x/m 960w')
    expect(props.src).toBe('https://images.example.com/x/m')
    expect(props.largeSrc).toBe('https://images.example.com/x/m')
  })

  it('uses the largest available variant as src when medium is missing', () => {
    const props = responsiveImageProps({
      url: 'https://cdn.example.com/a.jpg',
      images_variants: { thumb: 'https://images.example.com/x/t', large: 'https://images.example.com/x/l' },
    })
    expect(props.src).toBe('https://images.example.com/x/l')
  })
})

describe('audioProgressKey', () => {
  it('builds the namespaced progress key for an asset id', () => {
    expect(audioProgressKey(123)).toBe('s7ea:audio:123')
  })

  it('falls back to "unknown" when there is no asset id', () => {
    expect(audioProgressKey(undefined)).toBe('s7ea:audio:unknown')
  })
})

describe('findChapterIndex', () => {
  const chapters = [
    { title: 'Intro', start: 0 },
    { title: 'Main', start: 60 },
    { title: 'Outro', start: 120 },
  ]

  it('returns the last chapter whose start is <= time', () => {
    expect(findChapterIndex(chapters, 0)).toBe(0)
    expect(findChapterIndex(chapters, 59.9)).toBe(0)
    expect(findChapterIndex(chapters, 60)).toBe(1)
    expect(findChapterIndex(chapters, 200)).toBe(2)
  })

  it('returns -1 for empty or missing chapters', () => {
    expect(findChapterIndex([], 10)).toBe(-1)
    expect(findChapterIndex(undefined, 10)).toBe(-1)
  })
})

describe('shouldPersistProgress', () => {
  it('throttles writes to the configured interval', () => {
    const now = 1_000_000
    expect(shouldPersistProgress(now - AUDIO_PROGRESS_SAVE_INTERVAL_MS, now)).toBe(true)
    expect(shouldPersistProgress(now - AUDIO_PROGRESS_SAVE_INTERVAL_MS + 1, now)).toBe(false)
    expect(shouldPersistProgress(now, now)).toBe(false)
  })
})

describe('parseStoredProgress', () => {
  it('parses valid persisted values', () => {
    expect(parseStoredProgress('42.5')).toBe(42.5)
    expect(parseStoredProgress('0')).toBe(0)
  })

  it('rejects garbage', () => {
    expect(parseStoredProgress(null)).toBeUndefined()
    expect(parseStoredProgress('')).toBeUndefined()
    expect(parseStoredProgress('nope')).toBeUndefined()
    expect(parseStoredProgress('-3')).toBeUndefined()
  })
})
