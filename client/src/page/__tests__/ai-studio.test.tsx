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
let jobsResponse: AIJob[] = [
  {
    id: 1,
    job_type: "derive",
    status: "ready",
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
      list: async () => ({ data: { stories: [], total: 0 } }),
      get: async () => ({ error: { value: "no" } }),
    },
    media: {
      list: async () => ({ data: { size: 0, data: [], hasNext: false } }),
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
    await findByText("ai_studio.jobs.status.ready");
    expect(getByText("ai_studio.jobs.status.processing")).toBeDefined();
  });

  it("shows the AI-disabled banner and blocks new tasks when the master switch is off", async () => {
    settingsResponse = { ai_enabled: false, daily_call_quota: 200 };
    const { findAllByText, getByText } = render(<AIStudioPage />);

    // Page-level banner plus the jobs-tab warning share the title.
    expect((await findAllByText("ai_studio.disabled_title")).length).toBeGreaterThan(0);
    expect((getByText("ai_studio.jobs.new") as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens the new-task wizard and walks to capability selection", async () => {
    const user = userEvent.setup();
    const { findByText, getByText, getByPlaceholderText } = render(<AIStudioPage />);

    await findByText("ai_studio.jobs.status.ready");
    await user.click(getByText("ai_studio.jobs.new"));
    expect(getByText("ai_studio.wizard.title")).toBeDefined();

    // Step 1: pick the pasted-text material so "next" becomes available.
    await user.click(getByText("ai_studio.wizard.material_text"));
    await user.type(getByPlaceholderText("ai_studio.wizard.paste_text_placeholder"), "待处理文本");
    await user.click(getByText("ai_studio.wizard.next"));

    // Step 2: capability cards.
    expect(getByText("ai_studio.wizard.capability_transcribe")).toBeDefined();
    expect(getByText("ai_studio.wizard.capability_derive")).toBeDefined();
    expect(getByText("ai_studio.wizard.capability_check")).toBeDefined();
  });
});
