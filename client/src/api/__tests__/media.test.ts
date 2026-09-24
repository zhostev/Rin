// Tests for the Stage 2 MediaAPI contract client.
//
// The endpoints, request shapes and response shapes below mirror the
// backend contract verbatim (server/src/services/media.ts, base path
// /api/admin/media); these tests pin the frontend side so a contract drift
// fails loudly here instead of silently in the browser.

import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  isNotConfiguredError,
  MediaAPI,
  MediaUploadError,
  pollStreamUntilReady,
} from "../media";
import type { MediaAsset } from "../story";

const fakeHttp = {
  get: mock(),
  post: mock(),
  put: mock(),
  delete: mock(),
};

const api = new MediaAPI(fakeHttp as never);

const ok = <T>(data: T) => ({ data, error: undefined });

function sampleAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 7,
    kind: "video",
    source: "stream",
    title: "Talk",
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(fakeHttp)) fn.mockClear();
});

describe("MediaAPI endpoints", () => {
  it("mints a Stream direct upload with a filename body", async () => {
    const asset = sampleAsset({ stream_uid: "uid-abc", stream_status: "uploading" });
    fakeHttp.post.mockResolvedValue(ok({ asset, uploadURL: "https://upload.example/tus" }));
    const { data, error } = await api.createStreamDirectUpload({ filename: "talk.mp4" });
    expect(error).toBeUndefined();
    expect(fakeHttp.post).toHaveBeenCalledWith("/api/admin/media/stream/direct-upload", {
      filename: "talk.mp4",
    });
    expect(data?.uploadURL).toBe("https://upload.example/tus");
    expect(data?.asset).toEqual(asset);
  });

  it("fetches the latest Stream asset snapshot by stream_uid", async () => {
    const asset = sampleAsset({ stream_uid: "uid-abc", stream_status: "ready" });
    fakeHttp.get.mockResolvedValue(ok(asset));
    const { data } = await api.getStreamAsset("uid-abc");
    expect(fakeHttp.get).toHaveBeenCalledWith("/api/admin/media/stream/uid-abc");
    expect(data).toEqual(asset);
  });

  it("mints an Images direct upload with no request body", async () => {
    const asset = sampleAsset({ kind: "image", images_id: "img-1" });
    fakeHttp.post.mockResolvedValue(ok({ asset, uploadURL: "https://upload.example/img" }));
    const { data } = await api.createImageDirectUpload();
    expect(fakeHttp.post).toHaveBeenCalledWith("/api/admin/media/images/direct-upload");
    expect(data?.uploadURL).toBe("https://upload.example/img");
    expect(data?.asset).toEqual(asset);
  });

  it("finalizes an Images upload by images_id and returns the asset directly", async () => {
    const asset = sampleAsset({
      kind: "image",
      images_id: "img-1",
      images_variants: { thumb: "https://imagedelivery.net/x/thumb" },
    });
    fakeHttp.post.mockResolvedValue(ok(asset));
    const { data } = await api.finalizeImage("img-1");
    expect(fakeHttp.post).toHaveBeenCalledWith("/api/admin/media/images/img-1/finalize");
    expect(data).toEqual(asset);
  });

  it("lists the media library as { size, data, hasNext }", async () => {
    const assets = [sampleAsset()];
    fakeHttp.get.mockResolvedValue(ok({ size: 1, data: assets, hasNext: false }));
    const { data } = await api.list("video");
    expect(fakeHttp.get).toHaveBeenCalledWith("/api/admin/media?kind=video");
    expect(data?.data).toEqual(assets);
    expect(data?.size).toBe(1);
    expect(data?.hasNext).toBe(false);
  });

  it("lists the media library without a query when no kind is given", async () => {
    fakeHttp.get.mockResolvedValue(ok({ size: 0, data: [], hasNext: false }));
    await api.list();
    expect(fakeHttp.get).toHaveBeenCalledWith("/api/admin/media");
  });

  it("passes page and limit to the list endpoint", async () => {
    fakeHttp.get.mockResolvedValue(ok({ size: 42, data: [], hasNext: true }));
    await api.list("image", { page: 2, limit: 10 });
    expect(fakeHttp.get).toHaveBeenCalledWith("/api/admin/media?kind=image&page=2&limit=10");
  });

  it("deletes an asset by id", async () => {
    fakeHttp.delete.mockResolvedValue(ok("Deleted"));
    const { data } = await api.remove(9);
    expect(fakeHttp.delete).toHaveBeenCalledWith("/api/admin/media/9");
    expect(data).toBe("Deleted");
  });
});

describe("isNotConfiguredError", () => {
  it("detects the 503 not-configured response", () => {
    expect(isNotConfiguredError({ status: 503, value: "Audio upload storage is not configured" })).toBe(true);
    expect(isNotConfiguredError({ status: 400, value: "Invalid kind" })).toBe(false);
    expect(isNotConfiguredError({ status: 502, value: "upstream failed" })).toBe(false);
    expect(isNotConfiguredError(null)).toBe(false);
    expect(isNotConfiguredError(undefined)).toBe(false);
    // MediaUploadError from XHR carries the HTTP status too
    expect(isNotConfiguredError(new MediaUploadError("not configured", 503))).toBe(true);
  });
});

describe("pollStreamUntilReady", () => {
  const noSleep = async () => {};

  it("returns the ready asset snapshot", async () => {
    const getAsset = mock()
      .mockResolvedValueOnce(ok(sampleAsset({ stream_uid: "uid-abc", stream_status: "uploading" })))
      .mockResolvedValueOnce(ok(sampleAsset({ stream_uid: "uid-abc", stream_status: "processing" })))
      .mockResolvedValueOnce(
        ok(
          sampleAsset({
            stream_uid: "uid-abc",
            stream_status: "ready",
            embed_url: "https://iframe.videodelivery.net/uid-abc",
          }),
        ),
      );
    const seen: Array<string | undefined> = [];
    const result = await pollStreamUntilReady(getAsset, "uid-abc", {
      sleep: noSleep,
      onStatus: (asset) => seen.push(asset.stream_status),
    });
    expect(result.stream_status).toBe("ready");
    expect(result.embed_url).toBe("https://iframe.videodelivery.net/uid-abc");
    expect(seen).toEqual(["uploading", "processing", "ready"]);
    expect(getAsset).toHaveBeenCalledTimes(3);
    expect(getAsset).toHaveBeenCalledWith("uid-abc");
  });

  it("throws the stream_error on terminal error status", async () => {
    const getAsset = mock().mockResolvedValue(
      ok(sampleAsset({ stream_uid: "uid-abc", stream_status: "error", stream_error: "transcode failed" })),
    );
    await expect(pollStreamUntilReady(getAsset, "uid-abc", { sleep: noSleep })).rejects.toThrow(
      "transcode failed",
    );
  });

  it("throws on transport errors", async () => {
    const getAsset = mock().mockResolvedValue({ data: undefined, error: { value: "boom" } });
    await expect(pollStreamUntilReady(getAsset, "uid-abc", { sleep: noSleep })).rejects.toThrow("boom");
  });

  it("gives up after maxAttempts", async () => {
    const getAsset = mock().mockResolvedValue(
      ok(sampleAsset({ stream_uid: "uid-abc", stream_status: "processing" })),
    );
    await expect(
      pollStreamUntilReady(getAsset, "uid-abc", { sleep: noSleep, maxAttempts: 3 }),
    ).rejects.toThrow("after 3 checks");
    expect(getAsset).toHaveBeenCalledTimes(3);
  });
});

describe("uploadAudio (multipart XHR)", () => {
  class FakeXHR {
    static instances: FakeXHR[] = [];
    upload = { addEventListener: mock() };
    private listeners = new Map<string, Array<() => void>>();
    status = 200;
    responseText = "";
    openedAs: Array<[string, string]> = [];
    headers: Record<string, string> = {};
    sentBody: unknown;

    constructor() {
      FakeXHR.instances.push(this);
    }
    open(method: string, url: string) {
      this.openedAs.push([method, url]);
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    addEventListener(type: string, cb: () => void) {
      const list = this.listeners.get(type) ?? [];
      list.push(cb);
      this.listeners.set(type, list);
    }
    send(body: unknown) {
      this.sentBody = body;
    }
    fire(type: string) {
      for (const cb of this.listeners.get(type) ?? []) cb();
    }
  }

  const realXHR = globalThis.XMLHttpRequest;
  const realFormData = globalThis.FormData;

  beforeEach(() => {
    FakeXHR.instances = [];
    (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  });

  it("POSTs multipart form data to /api/admin/media/audio and resolves the bare asset", async () => {
    const asset = sampleAsset({ kind: "audio", url: "https://r2.example/a.mp3" });
    const promise = api.uploadAudio(new File(["audio"], "talk.mp3", { type: "audio/mpeg" }));
    const xhr = FakeXHR.instances[0];
    expect(xhr.openedAs[0][0]).toBe("POST");
    expect(xhr.openedAs[0][1].endsWith("/api/admin/media/audio")).toBe(true);
    expect(xhr.sentBody).toBeInstanceOf(realFormData);
    const fields = Object.fromEntries((xhr.sentBody as FormData).entries());
    expect(fields.file).toBeInstanceOf(File);
    expect("title" in fields).toBe(false);
    xhr.status = 201;
    xhr.responseText = JSON.stringify(asset);
    xhr.fire("load");
    await expect(promise).resolves.toEqual(asset);
    (globalThis as Record<string, unknown>).XMLHttpRequest = realXHR;
  });

  it("sends the optional title field", async () => {
    const asset = sampleAsset({ kind: "audio" });
    const promise = api.uploadAudio(
      new File(["audio"], "talk.mp3", { type: "audio/mpeg" }),
      undefined,
      "My talk",
    );
    const xhr = FakeXHR.instances[0];
    const fields = Object.fromEntries((xhr.sentBody as FormData).entries());
    expect(fields.title).toBe("My talk");
    xhr.status = 201;
    xhr.responseText = JSON.stringify(asset);
    xhr.fire("load");
    await expect(promise).resolves.toEqual(asset);
    (globalThis as Record<string, unknown>).XMLHttpRequest = realXHR;
  });

  it("rejects with a MediaUploadError carrying the HTTP status", async () => {
    const promise = api.uploadAudio(new File(["audio"], "talk.mp3", { type: "audio/mpeg" }));
    const xhr = FakeXHR.instances[0];
    xhr.status = 413;
    xhr.responseText = "too large";
    xhr.fire("load");
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(MediaUploadError);
    expect((err as MediaUploadError).status).toBe(413);
    expect((err as Error).message).toContain("HTTP 413");
    (globalThis as Record<string, unknown>).XMLHttpRequest = realXHR;
  });

  it("marks the 503 not-configured response with status 503", async () => {
    const promise = api.uploadAudio(new File(["audio"], "talk.mp3", { type: "audio/mpeg" }));
    const xhr = FakeXHR.instances[0];
    xhr.status = 503;
    xhr.responseText = JSON.stringify({
      error: { code: "storage_not_configured", message: "Audio upload storage is not configured" },
    });
    xhr.fire("load");
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(MediaUploadError);
    expect((err as MediaUploadError).status).toBe(503);
    expect(isNotConfiguredError(err as MediaUploadError)).toBe(true);
    (globalThis as Record<string, unknown>).XMLHttpRequest = realXHR;
  });

  it("rejects on invalid JSON responses", async () => {
    const promise = api.uploadAudio(new File(["audio"], "talk.mp3", { type: "audio/mpeg" }));
    const xhr = FakeXHR.instances[0];
    xhr.status = 201;
    xhr.responseText = "not json";
    xhr.fire("load");
    await expect(promise).rejects.toThrow("Invalid response");
    (globalThis as Record<string, unknown>).XMLHttpRequest = realXHR;
  });
});

describe("MediaAPI R2 direct upload", () => {
  it("mints an R2 direct upload with kind/filename/mimeType/size", async () => {
    const asset = sampleAsset({ kind: "video", source: "r2" });
    fakeHttp.post.mockResolvedValue(ok({ asset, uploadURL: "https://r2.example/put", key: "media/original/7/a.mp4" }));
    const { data, error } = await api.createR2DirectUpload({
      kind: "video",
      filename: "a.mp4",
      mimeType: "video/mp4",
      size: 1234,
      title: "a.mp4",
    });
    expect(error).toBeUndefined();
    expect(fakeHttp.post).toHaveBeenCalledWith("/api/admin/media/r2/direct-upload", {
      kind: "video",
      filename: "a.mp4",
      mimeType: "video/mp4",
      size: 1234,
      title: "a.mp4",
    });
    expect(data?.uploadURL).toBe("https://r2.example/put");
    expect(data?.key).toBe("media/original/7/a.mp4");
  });

  it("completes an R2 direct upload by asset id", async () => {
    const asset = sampleAsset({ kind: "video", source: "r2" });
    fakeHttp.post.mockResolvedValue(ok(asset));
    const { data, error } = await api.completeR2DirectUpload(7);
    expect(error).toBeUndefined();
    expect(fakeHttp.post).toHaveBeenCalledWith("/api/admin/media/r2/7/complete");
    expect(data).toEqual(asset);
  });
});
