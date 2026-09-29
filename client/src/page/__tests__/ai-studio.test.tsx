import "../../test/setup";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AIArtifact, AIJob, AIJobDetailResponse, AISettings } from "../../api/ai-studio";

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
    job_type: "aistudio.derive" as AIJob["job_type"],
    status: "completed",
    input: { storyId: 3 },
    created_at: "2026-09-24T10:00:00.000Z",
    updated_at: "2026-09-24T10:02:00.000Z",
  },
  {
    id: 2,
    job_type: "aistudio.transcribe" as AIJob["job_type"],
    status: "processing",
    input: { assetId: 9 },
    created_at: "2026-09-24T11:00:00.000Z",
    updated_at: "2026-09-24T11:01:00.000Z",
  },
];
// 为空时 getJob mock 回退到 jobsResponse[0] + 无产物。
let jobDetailResponse: AIJobDetailResponse | null = null;

mock.module("../../app/runtime", () => ({
  client: {
    aiStudio: {
      getSettings: async () => ({ data: settingsResponse }),
      listJobs: async () => ({ data: { jobs: jobsResponse, page: 1, hasNext: false } }),
      getJob: async () => ({ data: jobDetailResponse ?? { job: jobsResponse[0], artifacts: [] } }),
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
    jobDetailResponse = null;
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

    // 服务端下发的 job_type 是队列任务名（aistudio.*），标题必须去掉前缀
    // 拼出正确的 capability i18n key（回归：曾直接显示 capability_aistudio.derive）。
    expect(getByText("#1 · ai_studio.wizard.capability_derive")).toBeDefined();
    expect(getByText("#2 · ai_studio.wizard.capability_transcribe")).toBeDefined();
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

    // Step 2: only retrieval-test, embed and video accept free text; the rest
    // require storyId/assetId and must not be offered.
    expect(getByText("ai_studio.wizard.capability_retrieval_test")).toBeDefined();
    expect(getByText("ai_studio.wizard.capability_embed")).toBeDefined();
    // video 接受纯文本 prompt（文生视频）
    expect(getByText("ai_studio.wizard.capability_video")).toBeDefined();
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

    // Step 2: transcribe needs an assetId, retrieval-test needs a question,
    // video needs a text prompt or an image asset — none of which a story offers.
    expect(getByText("ai_studio.wizard.capability_derive")).toBeDefined();
    expect(getByText("ai_studio.wizard.capability_check")).toBeDefined();
    expect(getByText("ai_studio.wizard.capability_embed")).toBeDefined();
    expect(queryByText("ai_studio.wizard.capability_transcribe")).toBeNull();
    expect(queryByText("ai_studio.wizard.capability_retrieval_test")).toBeNull();
    expect(queryByText("ai_studio.wizard.capability_video")).toBeNull();
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

    // Step 2: transcribe and embed accept an assetId; video accepts an image
    // asset as its first frame; the rest must not be offered.
    expect(getByText("ai_studio.wizard.capability_transcribe")).toBeDefined();
    expect(getByText("ai_studio.wizard.capability_embed")).toBeDefined();
    expect(getByText("ai_studio.wizard.capability_video")).toBeDefined();
    expect(queryByText("ai_studio.wizard.capability_derive")).toBeNull();
    expect(queryByText("ai_studio.wizard.capability_check")).toBeNull();
    expect(queryByText("ai_studio.wizard.capability_retrieval_test")).toBeNull();
  });

  it("renders the red error panel for failed artifacts without an accept button", async () => {
    const user = userEvent.setup();
    const failedJob: AIJob = { ...jobsResponse[1], status: "failed" };
    const errorArtifact: AIArtifact = {
      id: 7,
      output_json: {
        kind: "error",
        message: "AI 返回的 JSON 无法解析或缺少 summary",
        rawPreview: '{"summary": "截断',
      },
      accepted_at: null,
      created_at: "2026-09-24T11:02:00.000Z",
    };
    jobDetailResponse = { job: failedJob, artifacts: [errorArtifact] };
    const { findByText, getByText, queryByText, getAllByRole } = render(<AIStudioPage />);

    await findByText("ai_studio.jobs.status.processing");
    // 展开第二个任务（#2），加载其失败产物。
    const toggles = getAllByRole("button", { name: "ai_studio.jobs.toggle_detail" });
    await user.click(toggles[1]);

    // 红色错误面板：标题 + 具体错误 + 可展开 rawPreview。
    expect(await findByText("ai_studio.detail.artifact_error_title")).toBeDefined();
    expect(getByText("AI 返回的 JSON 无法解析或缺少 summary")).toBeDefined();
    expect(getByText("ai_studio.detail.artifact_error_raw")).toBeDefined();
    // 失败产物不可接受，只能驳回。
    expect(queryByText("ai_studio.detail.accept")).toBeNull();
    expect(getByText("ai_studio.detail.reject")).toBeDefined();
  });

  it("hides images from the asset picker when transcribing", async () => {
    mediaResponse = {
      size: 3,
      data: [
        { id: 7, kind: "audio", title: "t.mp3" },
        { id: 8, kind: "image", title: "pic.png" },
        { id: 9, kind: "video", title: "v.mp4" },
      ],
      hasNext: false,
    };
    const user = userEvent.setup();
    const { findByText, getByText, queryByText } = render(<AIStudioPage />);

    await findByText("ai_studio.jobs.status.completed");
    await user.click(getByText("ai_studio.jobs.new"));

    // Step 1: media-asset material defaults to the transcribe capability,
    // so the picker must only offer audio/video — never images.
    await user.click(getByText("ai_studio.wizard.material_asset"));
    await user.click(getByText("ai_studio.wizard.pick_asset"));
    expect(await findByText("t.mp3")).toBeDefined();
    expect(await findByText("v.mp4")).toBeDefined();
    expect(queryByText("pic.png")).toBeNull();
  });

  it("only offers images as the first frame when generating video", async () => {
    mediaResponse = {
      size: 3,
      data: [
        { id: 7, kind: "audio", title: "t.mp3" },
        { id: 8, kind: "image", title: "pic.png" },
        { id: 9, kind: "video", title: "v.mp4" },
      ],
      hasNext: false,
    };
    const user = userEvent.setup();
    const { findByText, getByText, getByPlaceholderText, queryByText } = render(<AIStudioPage />);

    await findByText("ai_studio.jobs.status.completed");
    await user.click(getByText("ai_studio.jobs.new"));

    // Step 1: pick a video asset while the capability is still transcribe.
    await user.click(getByText("ai_studio.wizard.material_asset"));
    await user.click(getByText("ai_studio.wizard.pick_asset"));
    await user.click(await findByText("v.mp4"));
    await user.click(getByText("ai_studio.wizard.next"));

    // Step 2: switch to video — a video asset is not a valid first frame.
    await user.click(getByText("ai_studio.wizard.capability_video"));
    expect(getByText("ai_studio.wizard.video_needs_image")).toBeDefined();

    // Back on step 1 the picker now only lists images. The stale selection
    // (a video asset) is no longer among the options, so the picker button
    // falls back to the raw id — open it via that label, then clear the
    // prefilled search (the stale id) to reveal the image options.
    await user.click(getByText("ai_studio.wizard.back"));
    await user.click(getByText("9"));
    // 下拉打开时搜索框会带入旧值（被筛掉的资源 id），手动清空以显示图片选项
    // 下拉打开时搜索框会带入旧值（被筛掉的资源 id），先清空再看选项
    const searchInput = getByPlaceholderText("ai_studio.wizard.pick_asset");
    await user.click(searchInput);
    await user.keyboard("{Home}{Shift>}{End}{/Shift}{Backspace}");
    expect(await findByText("pic.png")).toBeDefined();
    expect(queryByText("t.mp3")).toBeNull();
    expect(queryByText("v.mp4")).toBeNull();
  });

  it("configures video params and shows the cost estimate", async () => {
    const user = userEvent.setup();
    const { findByText, getByText, getByPlaceholderText } = render(<AIStudioPage />);

    await findByText("ai_studio.jobs.status.completed");
    await user.click(getByText("ai_studio.jobs.new"));

    // Step 1: the pasted text doubles as the text-to-video prompt.
    await user.click(getByText("ai_studio.wizard.material_text"));
    await user.type(
      getByPlaceholderText("ai_studio.wizard.paste_text_placeholder"),
      "一朵云在城市上空翻涌",
    );
    await user.click(getByText("ai_studio.wizard.next"));

    // Step 2: video params (duration/resolution/ratio) plus a cost estimate.
    await user.click(getByText("ai_studio.wizard.capability_video"));
    expect(getByText("ai_studio.wizard.video_duration")).toBeDefined();
    expect(getByText("ai_studio.wizard.video_resolution")).toBeDefined();
    expect(getByText("ai_studio.wizard.video_ratio")).toBeDefined();
    expect(getByText("ai_studio.wizard.video_cost_estimate")).toBeDefined();

    // Step 3: review shows the chosen params and the estimate again.
    // (keys share their <p> with values, so assert on textContent.)
    await user.click(getByText("ai_studio.wizard.next"));
    const reviewText = document.body.textContent ?? "";
    expect(reviewText).toContain("ai_studio.wizard.review_video_params");
    expect(reviewText).toContain("ai_studio.wizard.video_cost_estimate");
    expect(reviewText).toContain("16:9");
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

describe("capabilityKeyForJobType", () => {
  it("strips the aistudio. queue prefix and normalizes hyphens", async () => {
    const { capabilityKeyForJobType } = await import("../../api/ai-studio");
    expect(capabilityKeyForJobType("aistudio.transcribe")).toBe("ai_studio.wizard.capability_transcribe");
    expect(capabilityKeyForJobType("aistudio.derive")).toBe("ai_studio.wizard.capability_derive");
    expect(capabilityKeyForJobType("aistudio.check")).toBe("ai_studio.wizard.capability_check");
    expect(capabilityKeyForJobType("aistudio.retrieval-test")).toBe("ai_studio.wizard.capability_retrieval_test");
    expect(capabilityKeyForJobType("aistudio.embed")).toBe("ai_studio.wizard.capability_embed");
    expect(capabilityKeyForJobType("aistudio.video")).toBe("ai_studio.wizard.capability_video");
    // 兼容不带前缀的历史写法
    expect(capabilityKeyForJobType("derive")).toBe("ai_studio.wizard.capability_derive");
  });
});
