import "../../test/setup";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AnalyticsLiveResponse, AnalyticsOverview, AnalyticsVisit, AnalyticsVisitsResponse } from "@rin/api";

const overview: AnalyticsOverview = {
  range: { days: 7, from: "2026-09-14", to: "2026-09-20" },
  totals: { pv: 140, uv: 70, uvApproximate: true },
  // The rollup never covers the current day, so today is always zero here.
  today: { date: "2026-09-20", pv: 0, uv: 0 },
  yesterday: { date: "2026-09-19", pv: 20, uv: 10 },
  series: [
    { date: "2026-09-18", pv: 120, uv: 60 },
    { date: "2026-09-19", pv: 20, uv: 10 },
    { date: "2026-09-20", pv: 0, uv: 0 },
  ],
  // 紧邻区间之前的等长完整窗口：range.from 2026-09-14 往前 6 天。
  previous: { from: "2026-09-08", to: "2026-09-13", pv: 100, uv: 50 },
};

let overviewResponse: AnalyticsOverview = overview;

function live(totals: { pv: number; uv: number }, yesterday = { pv: 0, uv: 0 }): AnalyticsLiveResponse {
  return { available: true, date: "2026-09-20", totals, yesterday, uvApproximate: true, elapsedHours: 12 };
}

function liveUnavailable(): AnalyticsLiveResponse {
  return {
    available: false,
    date: "2026-09-20",
    totals: { pv: 0, uv: 0 },
    yesterday: { pv: 0, uv: 0 },
    uvApproximate: true,
    elapsedHours: 12,
  };
}

let liveResponse: AnalyticsLiveResponse = live({ pv: 0, uv: 0 });

const visit: AnalyticsVisit = {
  timestamp: "2026-09-21T02:31:07.000Z",
  feedId: 42,
  title: "Hello",
  path: "/feed/42",
  referrer: "www.google.com",
  country: "JP",
  city: "Tokyo",
  device: "mobile",
  visitor: "abcdef0123456789",
  ip: "203.0.113.7",
};

let visitsResponse: AnalyticsVisitsResponse = { available: true, items: [visit], sampled: false };

mock.module("../../app/runtime", () => ({
  client: {
    analytics: {
      getOverview: async () => ({ data: overviewResponse }),
      getTopFeeds: async () => ({ data: { items: [] } }),
      getDimensions: async () => ({ data: { type: "referrer", items: [] } }),
      getLive: async () => ({ data: liveResponse }),
      getVisits: async () => ({ data: visitsResponse }),
    },
  },
}));

mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

mock.module("react-helmet", () => ({
  Helmet: () => null,
}));

const { AnalyticsPage } = await import("../analytics");

describe("AnalyticsPage today cards", () => {
  beforeEach(() => {
    liveResponse = live({ pv: 0, uv: 0 });
    overviewResponse = overview;
    visitsResponse = { available: true, items: [visit], sampled: false };
  });

  afterEach(() => {
    cleanup();
  });

  it("fills the today cards from /analytics/live, not from the rolled-up zero", async () => {
    // 站点级当日累计：服务端已经聚合好，前端不再自己对每篇求和（那会把跨篇读者算两次）
    liveResponse = live({ pv: 30, uv: 15 });

    const { getByText } = render(<AnalyticsPage />);

    await waitFor(() => expect(getByText("30")).toBeDefined());
    expect(getByText("15")).toBeDefined();
  });

  it("shows the period-over-period comparison against yesterday", async () => {
    liveResponse = live({ pv: 30, uv: 20 }, { pv: 20, uv: 10 });

    const { getAllByText, getByText } = render(<AnalyticsPage />);

    // 30 page views today vs 20 yesterday, 20 visitors vs 10.
    await waitFor(() => expect(getByText("50%")).toBeDefined());
    expect(getByText("100%")).toBeDefined();
    expect(getAllByText("analytics.vs_yesterday").length).toBe(2);
  });

  it("degrades gracefully when live analytics are unavailable", async () => {
    liveResponse = liveUnavailable();

    const { getAllByText, getByText, queryByText } = render(<AnalyticsPage />);

    // Not an error state: the rest of the dashboard still renders.
    await waitFor(() => expect(getAllByText("analytics.live_unavailable").length).toBe(2));
    expect(queryByText("analytics.load_failed")).toBeNull();
    expect(getByText("analytics.trend")).toBeDefined();
    expect(getByText(String(overview.totals.pv))).toBeDefined();
    expect(queryByText("analytics.vs_yesterday")).toBeNull();
  });
});

describe("AnalyticsPage range cards", () => {
  beforeEach(() => {
    liveResponse = live({ pv: 0, uv: 0 });
    overviewResponse = overview;
    visitsResponse = { available: true, items: [visit], sampled: false };
  });

  afterEach(() => {
    cleanup();
  });

  it("compares the range totals against the preceding equal-length window", async () => {
    // 140 pv vs 100, 70 uv vs 50 — both +40%.
    const { getAllByText } = render(<AnalyticsPage />);

    await waitFor(() => expect(getAllByText("analytics.vs_previous").length).toBe(2));
    expect(getAllByText("40%").length).toBe(2);
  });

  it("does not render the arrow when the previous window has no traffic", async () => {
    // 基数为 0 时不渲染，避免除以零。
    overviewResponse = { ...overview, previous: { from: "2026-09-08", to: "2026-09-13", pv: 0, uv: 0 } };

    const { getByText, queryByText } = render(<AnalyticsPage />);

    await waitFor(() => expect(getByText("analytics.trend")).toBeDefined());
    expect(queryByText("analytics.vs_previous")).toBeNull();
    // 区间数字本身照常渲染。
    expect(getByText(String(overview.totals.pv))).toBeDefined();
  });

  it("keeps the approximate-UV badge alongside the new arrow", async () => {
    const { getAllByText } = render(<AnalyticsPage />);

    await waitFor(() => expect(getAllByText("analytics.vs_previous").length).toBe(2));
    // Two badges: the today UV card (live is available here) and the range UV card.
    // The new arrow must not have displaced either of them.
    expect(getAllByText("analytics.uv_approximate").length).toBe(2);
  });
});

describe("AnalyticsPage visit detail", () => {
  beforeEach(() => {
    liveResponse = live({ pv: 0, uv: 0 });
    overviewResponse = overview;
    visitsResponse = { available: true, items: [visit], sampled: false };
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a row per visit, including the ip", async () => {
    const { getByText } = render(<AnalyticsPage />);

    await waitFor(() => expect(getByText("203.0.113.7")).toBeDefined());
    expect(getByText("www.google.com")).toBeDefined();
    expect(getByText("JP / Tokyo")).toBeDefined();
    // 访客列只显示指纹前 8 位。
    expect(getByText("abcdef01")).toBeDefined();
  });

  it("shows an em dash for a visit recorded before ip capture existed", async () => {
    visitsResponse = { available: true, items: [{ ...visit, ip: "" }], sampled: false };

    const { getAllByText, queryByText } = render(<AnalyticsPage />);

    await waitFor(() => expect(getAllByText("—").length).toBeGreaterThan(0));
    expect(queryByText("203.0.113.7")).toBeNull();
  });

  it("warns when the listing is sampled", async () => {
    visitsResponse = { available: true, items: [visit], sampled: true };

    const { getByText } = render(<AnalyticsPage />);

    await waitFor(() => expect(getByText("analytics.visits.sampled")).toBeDefined());
  });

  it("shows the empty state rather than an error when there are no visits", async () => {
    visitsResponse = { available: true, items: [], sampled: false };

    const { getByText, queryByText } = render(<AnalyticsPage />);

    await waitFor(() => expect(getByText("analytics.visits.empty")).toBeDefined());
    expect(queryByText("analytics.visits.load_failed")).toBeNull();
  });

  it("degrades gracefully when the visits query is unavailable, without treating it as an error", async () => {
    // liveResponse stays available (set in beforeEach), so any "analytics.live_unavailable"
    // text can only come from the visits section's own badge, not the today-card badges
    // (those only render that key when live itself is unavailable, which is a different
    // fixture — see the "AnalyticsPage today cards" describe block).
    visitsResponse = { available: false, items: [], sampled: false };

    const { getAllByText, getByText, queryByText } = render(<AnalyticsPage />);

    // Exactly one occurrence: if the badge were dropped, this fails at 0; if the today
    // cards' badge were somehow also showing, this would fail by being >1, so it can't
    // pass by accidentally matching the wrong badge.
    await waitFor(() => expect(getAllByText("analytics.live_unavailable").length).toBe(1));
    // Degradation is not an error: the visits-specific failure copy must not render.
    expect(queryByText("analytics.visits.load_failed")).toBeNull();
    // Degradation must not read as "there have been no visits": the empty-state copy
    // is for a genuinely empty history, not a token that lost Analytics Read.
    await waitFor(() => expect(getByText("analytics.visits.unavailable")).toBeDefined());
    expect(queryByText("analytics.visits.empty")).toBeNull();
    // The rest of the dashboard keeps rendering.
    expect(getByText("analytics.trend")).toBeDefined();
  });
});
