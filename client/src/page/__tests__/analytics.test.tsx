import "../../test/setup";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AnalyticsLiveResponse, AnalyticsOverview } from "@rin/api";

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
};

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

mock.module("../../app/runtime", () => ({
  client: {
    analytics: {
      getOverview: async () => ({ data: overview }),
      getTopFeeds: async () => ({ data: { items: [] } }),
      getDimensions: async () => ({ data: { type: "referrer", items: [] } }),
      getLive: async () => ({ data: liveResponse }),
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
