import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import type { FinanceTransaction, SharingReport } from "../api/client";
import { client } from "../app/runtime";
import { SettingsCard, SettingsCardBody, SettingsCardHeader, Spinner } from "@rin/ui";

function money(amount: number, currency = "CNY") {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function ReportsPage() {
  const { t } = useTranslation();
  const [reports, setReports] = useState<SharingReport[]>([]);
  const [selected, setSelected] = useState<SharingReport | null>(null);
  const [transactions, setTransactions] = useState<FinanceTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ title: "", periodStart: today(), periodEnd: today(), goals: "", summary: "" });
  const [transaction, setTransaction] = useState({ type: "expense" as "donation" | "expense", category: "storage", title: "", amount: "", occurredAt: today(), description: "" });

  const loadReports = useCallback(async () => {
    setLoading(true);
    const response = await client.reports.list();
    if (response.error) setError(response.error.value);
    else setReports(response.data || []);
    setLoading(false);
  }, []);

  const loadDetail = useCallback(async (id: number) => {
    const response = await client.reports.detail(id);
    if (response.error) setError(response.error.value);
    else if (response.data) {
      setSelected(response.data.report);
      setTransactions(response.data.transactions);
      setForm({
        title: response.data.report.title,
        periodStart: response.data.report.periodStart,
        periodEnd: response.data.report.periodEnd,
        goals: response.data.report.goals,
        summary: response.data.report.summary,
      });
    }
  }, []);

  useEffect(() => { void loadReports(); }, [loadReports]);

  async function createReport() {
    setBusy(true); setError("");
    const response = await client.reports.create(form);
    if (response.error) setError(response.error.value);
    else if (response.data) { await loadReports(); await loadDetail(response.data.id); }
    setBusy(false);
  }

  async function snapshot() {
    if (!selected) return;
    setBusy(true); setError("");
    const response = await client.reports.snapshot(selected.id);
    if (response.error) setError(response.error.value);
    else if (response.data) { setSelected(response.data); await loadReports(); await loadDetail(response.data.id); }
    setBusy(false);
  }

  async function publish() {
    if (!selected) return;
    setBusy(true); setError("");
    const response = await client.reports.update(selected.id, { status: selected.status === "published" ? "draft" : "published" });
    if (response.error) setError(response.error.value);
    else if (response.data) { setSelected(response.data); await loadReports(); }
    setBusy(false);
  }

  async function addTransaction() {
    if (!selected) return;
    const amount = Math.round(Number(transaction.amount) * 100);
    setBusy(true); setError("");
    const response = await client.reports.createTransaction({ ...transaction, reportId: selected.id, amount });
    if (response.error) setError(response.error.value);
    else if (response.data) { setTransactions((items) => [response.data!, ...items]); setTransaction((value) => ({ ...value, title: "", amount: "" })); await loadDetail(selected.id); }
    setBusy(false);
  }

  const inputClass = "w-full rounded-xl border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-theme dark:border-white/10";
  const finance = selected?.finance;

  return (
    <div className="space-y-4">
      {error ? <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">{error}</p> : null}
      <SettingsCard>
        <SettingsCardHeader title={t("reports.create_title")} description={t("reports.create_description")} />
        <SettingsCardBody>
          <div className="grid gap-3 md:grid-cols-2">
            <input className={inputClass} placeholder={t("reports.title_field")} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <input className={inputClass} placeholder={t("reports.goals")} value={form.goals} onChange={(e) => setForm({ ...form, goals: e.target.value })} />
            <input className={inputClass} type="date" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} />
            <input className={inputClass} type="date" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} />
          </div>
          <textarea className={`${inputClass} mt-3 min-h-20`} placeholder={t("reports.summary")} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />
          <button type="button" disabled={busy || !form.title} onClick={() => void createReport()} className="mt-3 rounded-xl bg-theme px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{t("reports.create")}</button>
        </SettingsCardBody>
      </SettingsCard>

      {loading ? <Spinner label={t("reports.loading")} /> : (
        <div className="grid gap-4 md:grid-cols-[240px_1fr]">
          <SettingsCard>
            <SettingsCardHeader title={t("reports.list")} description="" />
            <SettingsCardBody>
              <div className="space-y-2">{reports.map((report) => <button type="button" key={report.id} onClick={() => void loadDetail(report.id)} className={`block w-full rounded-xl p-3 text-left text-sm ${selected?.id === report.id ? "bg-theme text-white" : "bg-neutral-100 dark:bg-white/5"}`}><span className="block font-medium">{report.title}</span><span className="text-xs opacity-70">{report.periodStart} – {report.periodEnd}</span></button>)}</div>
            </SettingsCardBody>
          </SettingsCard>

          {selected ? <div className="space-y-4">
            <SettingsCard>
              <SettingsCardHeader title={selected.title} description={`${selected.periodStart} – ${selected.periodEnd}`} />
              <SettingsCardBody>
                <div className="grid gap-3 md:grid-cols-4">
                  <Metric label={t("reports.donations")} value={money(finance?.donationTotal || 0)} />
                  <Metric label={t("reports.expenses")} value={money(finance?.expenseTotal || 0)} />
                  <Metric label={t("reports.balance")} value={money(finance?.balance || 0)} />
                  <Metric label={t("reports.images")} value={String(selected.metrics.imageReferences)} />
                </div>
                <p className="mt-4 text-sm text-neutral-500 dark:text-neutral-400">{selected.goals || t("reports.no_goals")}</p>
                <div className="mt-4 flex gap-2"><button type="button" disabled={busy} onClick={() => void snapshot()} className="rounded-xl border border-black/10 px-3 py-2 text-sm dark:border-white/10">{t("reports.refresh_snapshot")}</button><button type="button" disabled={busy} onClick={() => void publish()} className="rounded-xl bg-theme px-3 py-2 text-sm text-white">{selected.status === "published" ? t("reports.unpublish") : t("reports.publish")}</button></div>
                {selected.status === "published" ? <Link href={`/reports/${selected.slug}`} className="mt-3 inline-block text-sm text-theme hover:underline">{t("reports.open_public")}</Link> : null}
              </SettingsCardBody>
            </SettingsCard>
            <SettingsCard>
              <SettingsCardHeader title={t("reports.transaction_title")} description={t("reports.amount_hint")} />
              <SettingsCardBody>
                <div className="grid gap-2 md:grid-cols-5"><select className={inputClass} value={transaction.type} onChange={(e) => setTransaction({ ...transaction, type: e.target.value as "donation" | "expense" })}><option value="expense">{t("reports.expense")}</option><option value="donation">{t("reports.donation")}</option></select><input className={inputClass} placeholder={t("reports.category")} value={transaction.category} onChange={(e) => setTransaction({ ...transaction, category: e.target.value })} /><input className={inputClass} placeholder={t("reports.title_field")} value={transaction.title} onChange={(e) => setTransaction({ ...transaction, title: e.target.value })} /><input className={inputClass} type="number" min="0.01" step="0.01" placeholder="0.00" value={transaction.amount} onChange={(e) => setTransaction({ ...transaction, amount: e.target.value })} /><input className={inputClass} type="date" value={transaction.occurredAt} onChange={(e) => setTransaction({ ...transaction, occurredAt: e.target.value })} /></div>
                <button type="button" disabled={busy || !transaction.title || !transaction.amount} onClick={() => void addTransaction()} className="mt-3 rounded-xl bg-theme px-4 py-2 text-sm text-white disabled:opacity-50">{t("reports.add_transaction")}</button>
                <div className="mt-4 divide-y divide-black/5 dark:divide-white/5">{transactions.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 py-3 text-sm"><div><p className="font-medium t-primary">{item.title}</p><p className="text-xs text-neutral-500">{item.occurredAt} · {item.category}</p></div><span className={item.type === "expense" ? "text-rose-600" : "text-emerald-600"}>{item.type === "expense" ? "−" : "+"}{money(item.amount, item.currency)}</span></div>)}</div>
              </SettingsCardBody>
            </SettingsCard>
          </div> : <SettingsCard><SettingsCardHeader title={t("reports.select")} description="" /></SettingsCard>}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-neutral-100 p-3 dark:bg-white/5"><p className="text-xs text-neutral-500">{label}</p><p className="mt-1 text-lg font-semibold t-primary">{value}</p></div>;
}
