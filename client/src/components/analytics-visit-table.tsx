import { useTranslation } from "react-i18next";
import type { AnalyticsVisit } from "../api/client";

export function VisitTable({ items }: { items: AnalyticsVisit[] }) {
  const { t } = useTranslation();

  return (
    // markdown.tsx 已经在用这套类名做窄屏横向滚动，沿用它而不是另造一套。
    <div className="block max-w-full overflow-x-auto">
      <table className="w-full min-w-max text-left text-sm">
        <thead className="text-neutral-500 dark:text-neutral-400">
          <tr>
            <th className="px-2 py-1 font-medium">{t("analytics.visits.time")}</th>
            <th className="px-2 py-1 font-medium">{t("analytics.visits.article")}</th>
            <th className="px-2 py-1 font-medium">{t("analytics.visits.referrer")}</th>
            <th className="px-2 py-1 font-medium">{t("analytics.visits.location")}</th>
            <th className="px-2 py-1 font-medium">{t("analytics.visits.device")}</th>
            <th className="px-2 py-1 font-medium">{t("analytics.visits.visitor")}</th>
            <th className="px-2 py-1 font-medium">{t("analytics.visits.ip")}</th>
          </tr>
        </thead>
        <tbody className="text-neutral-700 dark:text-neutral-200">
          {items.map((visit, index) => (
            <tr key={`${visit.timestamp}-${visit.visitor}-${index}`} className="border-t border-neutral-200 dark:border-neutral-700">
              {/* 看板别处按 UTC 天聚合，但「翻最近谁来过」看本地时间更符合直觉，
                  且 feed_card.tsx / adjacent_feed.tsx 都是这个写法。 */}
              <td className="whitespace-nowrap px-2 py-1 tabular-nums">
                {visit.timestamp ? new Date(visit.timestamp).toLocaleString() : "—"}
              </td>
              <td className="max-w-xs truncate px-2 py-1">
                <a className="hover:underline" href={`/feed/${visit.feedId}`}>
                  {visit.title || `#${visit.feedId}`}
                </a>
              </td>
              <td className="px-2 py-1">{visit.referrer || "—"}</td>
              <td className="whitespace-nowrap px-2 py-1">
                {[visit.country, visit.city].filter(Boolean).join(" / ") || "—"}
              </td>
              <td className="px-2 py-1">{visit.device || "—"}</td>
              <td className="px-2 py-1 font-mono text-xs">{visit.visitor.slice(0, 8) || "—"}</td>
              {/* Task 1 上线之前写入的数据点没有 blob8，显示 — 而不是空白，
                  免得看起来像故障。 */}
              <td className="whitespace-nowrap px-2 py-1 font-mono text-xs">{visit.ip || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
