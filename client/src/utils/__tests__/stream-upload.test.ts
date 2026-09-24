import { afterEach, describe, expect, it, mock } from 'bun:test'
import { startStreamUpload, STREAM_CHUNK_SIZE } from '../stream-upload'

interface CapturedOptions {
  endpoint?: string
  chunkSize?: number
  retryDelays?: number[]
  metadata?: Record<string, string>
  onProgress?: (uploaded: number, total: number) => void
  onSuccess?: () => void
  onError?: (error: Error) => void
}

class FakeUpload {
  static instances: FakeUpload[] = []
  options: CapturedOptions
  url: string | undefined
  started = false
  aborted = false

  constructor(_file: unknown, options: CapturedOptions) {
    this.options = options
    FakeUpload.instances.push(this)
  }
  start() {
    this.started = true
    return this
  }
  abort() {
    this.aborted = true
    return Promise.resolve()
  }
  succeed(url: string) {
    this.url = url
    this.options.onSuccess?.()
  }
  fail(message: string) {
    this.options.onError?.(new Error(message))
  }
  progress(uploaded: number, total: number) {
    this.options.onProgress?.(uploaded, total)
  }
}

mock.module('tus-js-client', () => ({
  Upload: FakeUpload,
}))

afterEach(() => {
  FakeUpload.instances = []
})

describe('startStreamUpload', () => {
  const file = new File(['video-bytes'], 'talk.mp4', { type: 'video/mp4' })

  it('drives tus-js-client with the Stream uploadURL and Cloudflare chunk sizing', () => {
    const handle = startStreamUpload(file, 'https://upload.example/one-time')
    const upload = FakeUpload.instances[0]

    expect(upload.started).toBe(true)
    expect(upload.options.endpoint).toBe('https://upload.example/one-time')
    expect(upload.options.chunkSize).toBe(STREAM_CHUNK_SIZE)
    expect(upload.options.chunkSize).toBeGreaterThanOrEqual(5 * 1024 * 1024)
    expect(upload.options.metadata).toEqual({ name: 'talk.mp4', filetype: 'video/mp4' })
    expect(upload.options.retryDelays?.length).toBeGreaterThan(0)
    // swallow the pending done promise; this test only inspects wiring
    handle.done.catch(() => {})
  })

  it('resolves done when tus reports success', async () => {
    const onSuccess = mock()
    const handle = startStreamUpload(file, 'https://upload.example/1', { onSuccess })

    FakeUpload.instances[0].succeed('https://upload.example/1/final')

    await expect(handle.done).resolves.toBe('https://upload.example/1/final')
    expect(onSuccess).toHaveBeenCalledWith('https://upload.example/1/final')
  })

  it('rejects done when tus reports an error', async () => {
    const onError = mock()
    const handle = startStreamUpload(file, 'https://upload.example/1', { onError })
    // NOTE: avoid expect().rejects here — bun deadlocks when the promise can
    // only settle via test code that runs after the assertion is created.
    const settled = handle.done.then(
      () => {
        throw new Error('expected done to reject')
      },
      (err: unknown) => err,
    )

    FakeUpload.instances[0].fail('chunk failed')

    const err = await settled
    expect((err as Error).message).toBe('chunk failed')
    expect(onError).toHaveBeenCalled()
  })

  it('forwards progress events to the caller', () => {
    const seen: Array<[number, number]> = []
    startStreamUpload(file, 'https://upload.example/1', {
      onProgress: (uploaded, total) => seen.push([uploaded, total]),
    })

    FakeUpload.instances[0].progress(25, 100)

    expect(seen).toEqual([[25, 100]])
  })

  it('aborts the underlying upload', async () => {
    const handle = startStreamUpload(file, 'https://upload.example/1')
    const settled = handle.done.then(
      () => {
        throw new Error('expected done to reject')
      },
      (err: unknown) => err,
    )

    handle.abort()

    const err = await settled
    expect((err as Error).message).toBe('Upload aborted')
    expect(FakeUpload.instances[0].aborted).toBe(true)
  })
})
