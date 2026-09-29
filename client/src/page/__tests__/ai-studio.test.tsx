import "../../test/setup";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AIJob, AISettings } from "../../api/ai-studio";

// react-modal (used by the job wizard) needs rAF; the shared jsdom setup
// does not provide it, so polyfill locally for this test file.
if (typeof globalThis.requestAnimationFrame === "undefined") {
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0)) as unknown as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof globalThis.cancelAnimationFrame;
}

let settingsResponse: AISettings = { ai_enabled: true, daily_call_quota: 200 };
let storiesResponse = { stories: [] as Array<{ id: number; title: string }>, total: 0 };
let mediaResponse = {
  size: 0,
  data: [] as Array<{ id: number; kind: string; title: string }>,
  hasNext: false,
};
let jobsResponse: AIJob[] = [
  {
    id: 1,
    job_type: "derive",
    status: "completed",
    input: { storyId: 3 },
    created_at: "2026-09-24T10:00:00.000Z",
    updated_at: "2026-09-24T10:02:00.000Z",
  },
  {
    id: 2,
    job_type: "transcribe",
    status: "processing",
    input: { assetId: 9 },
    created_at: "2026-09-24T11:00:00.000Z",
    updated_at: "2026-09-24T11:01:00.000Z",
  },
];

mock.module("../../app/runtime", () => ({
  client: {
    aiStudio: {
      getSettings: async () => ({ data: settingsResponse }),
      listJobs: async () => ({ data: { jobs: jobsResponse, page: 1, hasNext: false } }),
      getJob: async () => ({ data: { job: jobsResponse[0], artifacts: [] } }),
      acceptArtifact: async () => ({ data: { ok: true, applied: true } }),
      rejectArtifact: async () => ({ data: { ok: true } }),
    },
    story: {
      list: async () => ({ data: storiesResponse }),
      get: async () => ({ error: { value: "no" } }),
    },
    media: {
      list: async () => ({ data: mediaResponse }),
    },
  },
}));

mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

mock.module("react-helmet", () => ({
  Helmet: () => null,
}));

const { AIStudioPage } = await import("../ai-studio");

describe("AIStudioPage", () => {
  beforeEach(() => {
    settingsResponse = { ai_enabled: true, daily_call_quota: 200 };
    storiesResponse = { stories: [], total: 0 };
    mediaResponse = { size: 0, data: [], hasNext: false };
  });

  afterEach(() => {
    cleanup();
  });

  it("renders tabs and the polled job list", async () => {
    const { findByText, getByText } = render(<AIStudioPage />);

    expect(getByText("ai_studio.tabs.jobs")).toBeDefined();
    expect(getByText("ai_studio.tabs.usage")).toBeDefined();
    expect(getByText("ai_studio.tabs.settings")).toBeDefined();

    // Jobs arrive from the mocked listJobs call.
    await findByText("ai_studio.jobs.status.completed");
    expect(getByText("ai_studio.jobs.status.processing")).toBeDefined();
  });

  it("shows the AI-disabled banner and blocks new tasks when the master switch is off", async () => {
    settingsResponse = { ai_enabled: false, daily_call_quota: 200 };
    const { findAllByText, getByText } = render(<AIStudioPage />);

    // Page-level banner plus the jobs-tab warning share the title.
    expect((await findAllByText("ai_studio.disabled_title")).length).toBeGreaterThan(0);
    expect((getByText("ai_studio.jobs.new") as HTMLButtonElement).disabled).toBe(true);
  });

  it("only offers capabilities compatible with pasted text", async () => {
    const user = userEvent.setup();
    const { findByText, getByText, getByPlaceholderText, queryByText } = render(<AIStudioPage />);

    await findByText("ai_studio.jobs.status.completed");
    await user.click(getByText("ai_studio.jobs.new"));
    expect(getByText("ai_studio.wizard.title")).toBeDefined();

    // Step 1: pick the pasted-text material so "next" becomes available.
    await user.click(getByText("ai_studio.wizard.material_text"));
    await user.type(getByPlaceholderText("ai_studio.wizard.paste_text_placeholder"), "待处理文本");
    await user.click(getByText("ai_studio.wizard.next"));

    // Step 2: only retrieval-test and embed accept free text; the rest
    // require storyId/assetId and must not be offered.
    expect(getByText("ai_studio.wizard.capability_retrieval_test")).toBeDefined();
    expect(getByText("ai_studio.wizard.capability_embed")).toBeDefined();
    expect(queryByText("ai_studio.wizard.capability_transcribe")).toBeNull();
    expect(queryByText("ai_studio.wizard.capability_derive")).toBeNull();
    expect(queryByText("ai_studio.wizard.capability_check")).toBeNull();
  });

  it("only offers capabilities compatible with a story", async () => {
    storiesResponse = { stories: [{ id: 1, title: "测试文章" }], total: 1 };
    const user = userEvent.setup();
    const { findByText, getByText, queryByText } = render(<AIStudioPage />);

    await findByText("ai_studio.jobs.status.completed");
    await user.click(getByText("ai_studio.jobs.new"));

    // Step 1: story is the default material; pick a story.
    await user.click(getByText("ai_studio.wizard.pick_story"));
    await user.click(await findByText("测试文章"));
    await user.click(getByText("ai_studio.wizard.next"));

    // Step 2: transcribe needs an assetId, retrieval-test needs a question.
    expect(getByText("ai_studio.wizard.capability_derive")).toBeDefined();
    expect(getByText("ai_studio.wizard.capability_check")).toBeDefined();
    expect(getByText("ai_studio.wizard.capability_embed")).toBeDefined();
    expect(queryByText("ai_studio.wizard.capability_transcribe")).toBeNull();
    expect(queryByText("ai_studio.wizard.capability_retrieval_test")).toBeNull();
  });

  it("only offers capabilities compatible with a media asset", async () => {
    mediaResponse = { size: 1, data: [{ id: 7, kind: "audio", title: "t.mp3" }], hasNext: false };
    const user = userEvent.setup();
    const { findByText, getByText, queryByText } = render(<AIStudioPage />);

    await findByText("ai_studio.jobs.status.completed");
    await user.click(getByText("ai_studio.jobs.new"));

    // Step 1: switch to the media-asset material and pick an asset.
    await user.click(getByText("ai_studio.wizard.material_asset"));
    await user.click(getByText("ai_studio.wizard.pick_asset"));
    await user.click(await findByText("t.mp3"));
    await user.click(getByText("ai_studio.wizard.next"));

    // Step 2: only transcribe and embed accept an assetId.
    expect(getByText("ai_studio.wizard.capability_transcribe")).toBeDefined();
    expect(getByText("ai_studio.wizard.capability_embed")).toBeDefined();
    expect(queryByText("ai_studio.wizard.capability_derive")).toBeNull();
    expect(queryByText("ai_studio.wizard.capability_check")).toBeNull();
    expect(queryByText("ai_studio.wizard.capability_retrieval_test")).toBeNull();
  });
});

describe("formatDateTime", () => {
  it("renders Unix-seconds timestamps as local dates (not 1970)", async () => {
    const { formatDateTime } = await import("../ai-studio");
    // 2026-09-28T08:26:40Z in seconds — the real API shape from serializeJob/serializeArtifact.
    const out = formatDateTime(1790584000);
    expect(out).not.toContain("1970");
    expect(out).toContain("2026");
  });

  it("still renders ISO strings (mock fixtures)", async () => {
    const { formatDateTime } = await import("../ai-studio");
    expect(formatDateTime("2026-09-24T10:00:00.000Z")).toContain("2026");
  });

  it("renders millisecond timestamps and placeholders", async () => {
    const { formatDateTime } = await import("../ai-studio");
    expect(formatDateTime(1790584000000)).toContain("2026");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
  });
});
