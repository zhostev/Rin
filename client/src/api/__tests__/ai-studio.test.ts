import { beforeEach, describe, expect, it } from "bun:test";
import { AIStudioAPI, AskAPI } from "../ai-studio";

// Capture calls through a fake http surface instead of the real HttpClient.
const calls: Array<{ method: string; path: string; body?: unknown }> = [];
const fakeHttp = {
  get: async <T,>(path: string): Promise<{ data: T }> => {
    calls.push({ method: "GET", path });
    return { data: undefined as T };
  },
  post: async <T,>(path: string, body?: unknown): Promise<{ data: T }> => {
    calls.push({ method: "POST", path, body });
    return { data: undefined as T };
  },
  put: async <T,>(path: string, body?: unknown): Promise<{ data: T }> => {
    calls.push({ method: "PUT", path, body });
    return { data: undefined as T };
  },
};

const studio = new AIStudioAPI(fakeHttp);
const askApi = new AskAPI(fakeHttp);

describe("AIStudioAPI contract", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("POSTs new jobs to /api/admin/ai-studio/jobs with kind/input/params", async () => {
    await studio.createJob({
      kind: "derive",
      input: { storyId: 3 },
      params: { derive: "summary" },
    });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/admin/ai-studio/jobs",
        body: { kind: "derive", input: { storyId: 3 }, params: { derive: "summary" } },
      },
    ]);
  });

  it("lists jobs with optional status/page query params", async () => {
    await studio.listJobs({ status: "processing", page: 2 });
    expect(calls[0]).toEqual({
      method: "GET",
      path: "/api/admin/ai-studio/jobs?status=processing&page=2",
    });
    calls.length = 0;
    await studio.listJobs();
    expect(calls[0]).toEqual({ method: "GET", path: "/api/admin/ai-studio/jobs" });
  });

  it("fetches job detail with an encoded id", async () => {
    await studio.getJob("job/1");
    expect(calls[0]).toEqual({ method: "GET", path: "/api/admin/ai-studio/jobs/job%2F1" });
  });

  it("accepts/rejects artifacts on the contracted endpoints", async () => {
    await studio.acceptArtifact(42);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/admin/ai-studio/artifacts/42/accept",
      body: undefined,
    });
    calls.length = 0;
    await studio.rejectArtifact(42);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/admin/ai-studio/artifacts/42/reject",
      body: undefined,
    });
  });

  it("fetches usage with a days window defaulting to 30", async () => {
    await studio.getUsage();
    expect(calls[0]).toEqual({ method: "GET", path: "/api/admin/ai-studio/usage?days=30" });
    calls.length = 0;
    await studio.getUsage(7);
    expect(calls[0]).toEqual({ method: "GET", path: "/api/admin/ai-studio/usage?days=7" });
  });

  it("reads and writes settings on /api/admin/ai-studio/settings", async () => {
    await studio.getSettings();
    expect(calls[0]).toEqual({ method: "GET", path: "/api/admin/ai-studio/settings" });
    calls.length = 0;
    await studio.updateSettings({ ai_enabled: false, daily_call_quota: 50 });
    expect(calls[0]).toEqual({
      method: "PUT",
      path: "/api/admin/ai-studio/settings",
      body: { ai_enabled: false, daily_call_quota: 50 },
    });
  });
});

describe("AskAPI contract", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("POSTs questions to /api/ask with question and mode", async () => {
    await askApi.ask("站内有什么视频？", "full");
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/ask",
      body: { question: "站内有什么视频？", mode: "full" },
    });
    calls.length = 0;
    await askApi.ask("hello");
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/ask",
      body: { question: "hello" },
    });
  });

  it("fetches recommendations with an encoded storyId", async () => {
    await askApi.recommend("my-story");
    expect(calls[0]).toEqual({
      method: "GET",
      path: "/api/ask/recommend?storyId=my-story",
    });
  });
});
