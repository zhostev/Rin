import { SettingsBadge, SettingsCard, SettingsCardBody, SettingsCardHeader, Spinner } from "@rin/ui";
import { useCallback, useState } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import type {
  AnalyticsDimensionsResponse,
  AnalyticsDimensionType,
  AnalyticsLiveResponse,
  AnalyticsOverview,
  AnalyticsTopFeedsResponse,
} from "../api/client";
import { client } from "../app/runtime";
import { BarList, LineChart } from "../components/analytics-charts";
import { useApiResource } from "../hooks/use-api-resource";
import { useSiteConfig } from "../hooks/useSiteConfig";

type AnalyticsRangeDays = 7 | 30 | 90;

const RANGE_OPTIONS: AnalyticsRangeDays[] = [7, 30, 90];

/**
 * 环比指示器（设计文档 §8.1）。
 * 昨日为 0 时不渲染：没有可比基数，百分比不成立。
 */
function ChangeIndicator({ current, previous }: { current: number; previous: number }) {
  const { t } = useTranslation();

  if (previous <= 0) {
    return null;
  }

  const percent = Math.round(((current - previous) / previous) * 100);
  const tone =
    percent === 0
      ? "text-neutral-500 dark:text-neutral-400"
      : percent > 0
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-rose-600 dark:text-rose-400";
  const icon = percent === 0 ? "ri-subtract-line" : percent > 0 ? "ri-arrow-up-line" : "ri-arrow-down-line";

  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${tone}`}>
      <i className={icon} aria-hidden="true" />
      <span className="tabular-nums">{`${Math.abs(percent)}%`}</span>
      <span className="text-neutral-500 dark:text-neutral-400">{t("analytics.vs_yesterday")}</span>
    </span>
  );
}

function DimensionSection({
  title,
  type,
  days,
}: {
  title: string;
  type: AnalyticsDimensionType;
  days: AnalyticsRangeDays;
}) {
  const { t } = useTranslation();
  const loadDimensions = useCallback(() => client.analytics.getDimensions(type, days), [type, days]);
  const { data, loading, error } = useApiResource<AnalyticsDimensionsResponse>(loadDimensions);
  const items = Array.isArray(data?.items) ? data.items : [];

  return (
    <SettingsCard>
      <SettingsCardHeader title={title} description="" />
      <SettingsCardBody>
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Spinner label={title} />
          </div>
        ) : error ? (
          <p className="text-sm text-rose-600 dark:text-rose-300">{t("analytics.load_failed")}</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{t("analytics.empty")}</p>
        ) : (
          <BarList items={items.map((item) => ({ label: item.value, value: item.count }))} />
        )}
      </SettingsCardBody>
    </SettingsCard>
  );
}

export function AnalyticsPage() {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();
  const [days, setDays] = useState<AnalyticsRangeDays>(30);

  const loadOverview = useCallback(() => client.analytics.getOverview(days), [days]);
  const { data: overview, loading: overviewLoading, error: overviewError } = useApiResource<AnalyticsOverview>(loadOverview);

  const loadTopFeeds = useCallback(() => client.analytics.getTopFeeds(days), [days]);
  const { data: topFeedsData, loading: topFeedsLoading, error: topFeedsError } = useApiResource<AnalyticsTopFeedsResponse>(loadTopFeeds);

  // cron 从不聚合当天（未完结的一天不能冻进永久表），所以 analytics_daily 里没有今天。
  // 今日两张卡只能走 /analytics/live，它正好覆盖尚未聚合的当天数据。
  const loadLive = useCallback(() => client.analytics.getLive(24), []);
  const { data: live, loading: liveLoading, error: liveError } = useApiResource<AnalyticsLiveResponse>(loadLive);

  const series = overview?.series ?? [];
  const topFeeds = Array.isArray(topFeedsData?.items) ? topFeedsData.items : [];

  // API token 缺少 Account Analytics Read 时返回 available:false，
  // 这不是错误状态：其余板块照常渲染，今日卡退回聚合值。
  const liveAvailable = !liveLoading && !liveError && live?.available === true;
  const liveTotals = (liveAvailable ? live?.items ?? [] : []).reduce(
    (totals, item) => ({ pv: totals.pv + item.pv, uv: totals.uv + item.uv }),
    { pv: 0, uv: 0 },
  );
  const todayPv = liveAvailable ? liveTotals.pv : overview?.today.pv ?? 0;
  const todayUv = liveAvailable ? liveTotals.uv : overview?.today.uv ?? 0;
  const liveWarning = !liveLoading && !liveAvailable ? (
    <SettingsBadge tone="warning">{t("analytics.live_unavailable")}</SettingsBadge>
  ) : undefined;

  // series 现在由服务端补零，长度恒等于区间天数，不能再用它判断「有没有数据」。
  const hasHistory = series.some((point) => point.pv > 0 || point.uv > 0);
  const hasData = hasHistory || todayPv > 0 || todayUv > 0;
  // live 未落定前不下「无数据」结论，避免空状态闪一下再被今日数据顶掉。
  const showEmpty = !overviewLoading && !liveLoading && !overviewError && !hasData;
  const showContent = !overviewLoading && !overviewError && overview !== null && hasData;

  return (
    <div className="flex w-full flex-col gap-4">
      <Helmet>
        <title>{`${t("analytics.title")} - ${siteConfig.name}`}</title>
      </Helmet>

      <div className="flex flex-wrap gap-2">
        {RANGE_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setDays(option)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              days === option
                ? "bg-theme text-white"
                : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-white/5 dark:text-neutral-300 dark:hover:bg-white/10"
            }`}
          >
            {t(`analytics.range.${option}`)}
          </button>
        ))}
      </div>

      {overviewLoading ? (
        <div className="flex items-center gap-3 py-8 text-sm text-neutral-500 dark:text-neutral-400">
          <Spinner label={t("analytics.title")} />
          <span>{t("analytics.title")}</span>
        </div>
      ) : null}

      {overviewError ? (
        <SettingsCard tone="danger">
          <SettingsCardHeader title={t("analytics.load_failed")} description={overviewError} />
        </SettingsCard>
      ) : null}

      {showEmpty ? (
        <SettingsCard>
          <SettingsCardHeader title={t("analytics.empty")} description="" />
        </SettingsCard>
      ) : null}

      {showContent && overview ? (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <SettingsCard>
              <SettingsCardHeader
                title={String(todayPv)}
                description={t("analytics.today_pv")}
                badge={
                  liveAvailable ? (
                    <ChangeIndicator current={todayPv} previous={overview.yesterday.pv} />
                  ) : (
                    liveWarning
                  )
                }
              />
            </SettingsCard>
            <SettingsCard>
              <SettingsCardHeader
                title={String(todayUv)}
                description={t("analytics.today_uv")}
                badge={
                  liveAvailable ? (
                    <ChangeIndicator current={todayUv} previous={overview.yesterday.uv} />
                  ) : (
                    liveWarning
                  )
                }
              />
            </SettingsCard>
            <SettingsCard>
              <SettingsCardHeader title={String(overview.totals.pv)} description={t("analytics.range_pv")} />
            </SettingsCard>
            <SettingsCard>
              <SettingsCardHeader
                title={String(overview.totals.uv)}
                description={t("analytics.range_uv")}
                badge={
                  overview.totals.uvApproximate ? (
                    <SettingsBadge tone="warning">{t("analytics.uv_approximate")}</SettingsBadge>
                  ) : undefined
                }
              />
            </SettingsCard>
          </div>

          <SettingsCard>
            <SettingsCardHeader title={t("analytics.trend")} description="" />
            <SettingsCardBody>
              <LineChart points={overview.series.map((point) => ({ label: point.date, value: point.pv }))} />
            </SettingsCardBody>
          </SettingsCard>

          <SettingsCard>
            <SettingsCardHeader title={t("analytics.top_feeds")} description="" />
            <SettingsCardBody>
              {topFeedsLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Spinner label={t("analytics.top_feeds")} />
                </div>
              ) : topFeedsError ? (
                <p className="text-sm text-rose-600 dark:text-rose-300">{t("analytics.load_failed")}</p>
              ) : topFeeds.length === 0 ? (
                <p className="text-sm text-neutral-500 dark:text-neutral-400">{t("analytics.empty")}</p>
              ) : (
                <ul className="space-y-2">
                  {topFeeds.map((item) => (
                    <li key={item.feedId} className="flex items-center justify-between gap-3 text-sm">
                      <Link href={`/feed/${item.feedId}`} className="min-w-0 truncate t-primary hover:text-theme">
                        {item.title || t("queue_status.untitled")}
                      </Link>
                      <span className="shrink-0 tabular-nums text-neutral-500 dark:text-neutral-400">{item.pv}</span>
                    </li>
                  ))}
                </ul>
              )}
            </SettingsCardBody>
          </SettingsCard>

          <div className="grid gap-4 md:grid-cols-3">
            <DimensionSection title={t("analytics.referrer")} type="referrer" days={days} />
            <DimensionSection title={t("analytics.country")} type="country" days={days} />
            <DimensionSection title={t("analytics.device")} type="device" days={days} />
          </div>
        </>
      ) : null}
    </div>
  );
}
