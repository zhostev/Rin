import { SettingsBadge, SettingsCard, SettingsCardBody, SettingsCardHeader, Spinner } from "@rin/ui";
import { useCallback, useState } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import type {
  AnalyticsDimensionsResponse,
  AnalyticsDimensionType,
  AnalyticsOverview,
  AnalyticsTopFeedsResponse,
} from "../api/client";
import { client } from "../app/runtime";
import { BarList, LineChart } from "../components/analytics-charts";
import { useApiResource } from "../hooks/use-api-resource";
import { useSiteConfig } from "../hooks/useSiteConfig";

type AnalyticsRangeDays = 7 | 30 | 90;

const RANGE_OPTIONS: AnalyticsRangeDays[] = [7, 30, 90];

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

  const series = overview?.series ?? [];
  const topFeeds = Array.isArray(topFeedsData?.items) ? topFeedsData.items : [];
  const showEmpty = !overviewLoading && !overviewError && series.length === 0;
  const showContent = !overviewLoading && !overviewError && overview !== null && series.length > 0;

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
              <SettingsCardHeader title={String(overview.today.pv)} description={t("analytics.today_pv")} />
            </SettingsCard>
            <SettingsCard>
              <SettingsCardHeader title={String(overview.today.uv)} description={t("analytics.today_uv")} />
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
