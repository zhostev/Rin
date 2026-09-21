import { useEffect, useState } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import type { SharingReport } from "../api/client";
import { client } from "../app/runtime";

function money(amount: number, currency = "CNY") {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

export function PublicReportPage({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const [report, setReport] = useState<SharingReport | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    client.reports.getPublished(slug).then((response) => {
      if (response.error) setError(response.error.value);
      else setReport(response.data || null);
    });
  }, [slug]);

  if (error) return <div className="mx-auto max-w-3xl px-4 py-12 text-center text-rose-600">{error}</div>;
  if (!report) return <div className="mx-auto max-w-3xl px-4 py-12 text-center text-neutral-500">{t("reports.loading")}</div>;

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <Helmet><title>{report.title}</title></Helmet>
      <Link href="/" className="text-sm text-theme hover:underline">← {t("admin.back_to_site")}</Link>
      <header className="mt-6 border-b border-black/10 pb-6 dark:border-white/10">
        <p className="text-sm text-theme">{report.periodStart} – {report.periodEnd}</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight t-primary">{report.title}</h1>
        {report.goals ? <p className="mt-4 whitespace-pre-wrap leading-7 text-neutral-600 dark:text-neutral-300">{report.goals}</p> : null}
      </header>
      <section className="mt-6 grid gap-4 md:grid-cols-4">
        <Metric label={t("reports.donations")} value={money(report.finance.donationTotal)} />
        <Metric label={t("reports.expenses")} value={money(report.finance.expenseTotal)} />
        <Metric label={t("reports.balance")} value={money(report.finance.balance)} />
        <Metric label={t("reports.images")} value={String(report.metrics.imageReferences)} />
      </section>
      <section className="mt-8 rounded-2xl border border-black/10 p-6 dark:border-white/10">
        <h2 className="text-xl font-semibold t-primary">{t("reports.results")}</h2>
        <div className="mt-4 grid gap-4 text-sm md:grid-cols-3">
          <Metric label={t("reports.published_articles")} value={String(report.metrics.publishedArticles)} />
          <Metric label={t("reports.page_views")} value={String(report.metrics.pageViews)} />
          <Metric label={t("reports.categories")} value={String(report.finance.byCategory.length)} />
        </div>
        {report.summary ? <p className="mt-6 whitespace-pre-wrap leading-7 text-neutral-600 dark:text-neutral-300">{report.summary}</p> : null}
      </section>
      {report.finance.byCategory.length ? <section className="mt-6 rounded-2xl border border-black/10 p-6 dark:border-white/10"><h2 className="text-xl font-semibold t-primary">{t("reports.expense_breakdown")}</h2><div className="mt-4 space-y-3">{report.finance.byCategory.map((item) => <div className="flex justify-between text-sm" key={item.category}><span>{item.category}</span><span className="font-medium">{money(item.amount)}</span></div>)}</div></section> : null}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl bg-neutral-100 p-4 dark:bg-white/5"><p className="text-xs text-neutral-500">{label}</p><p className="mt-1 text-xl font-semibold t-primary">{value}</p></div>;
}
