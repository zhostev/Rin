import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import type {
    CreateFinanceTransactionRequest,
    CreateSharingReportRequest,
    FinanceSummary,
    FinanceTransaction,
    SharingReportMetrics,
} from "@rin/api";
import type { AppContext, Variables } from "../core/hono-types";
import { adminOnly } from "../core/route-boundaries";
import { BadRequestError, NotFoundError } from "../errors";
import { analyticsDaily, feeds, financeTransactions, sharingReports } from "../db/schema";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const IMAGE_PATTERN = /!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>/gi;

function parseDate(value: unknown, field: string) {
    if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
        throw new BadRequestError(`${field} must use YYYY-MM-DD`);
    }
    return value;
}

function dateRange(start: string, end: string) {
    const from = new Date(`${start}T00:00:00.000Z`);
    const to = new Date(`${end}T23:59:59.999Z`);
    if (from > to) throw new BadRequestError("periodStart must not be after periodEnd");
    return { from, to };
}

function parseJson<T>(value: string, fallback: T): T {
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

function slugFromTitle(title: string) {
    const base = title
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "sharing-report";
    return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

function toTransaction(row: typeof financeTransactions.$inferSelect): FinanceTransaction {
    return {
        id: row.id,
        reportId: row.reportId,
        type: row.type as FinanceTransaction["type"],
        category: row.category,
        title: row.title,
        description: row.description,
        amount: row.amount,
        currency: row.currency,
        occurredAt: row.occurredAt,
        receiptUrl: row.receiptUrl,
        isAnonymous: row.isAnonymous === 1,
        status: row.status as FinanceTransaction["status"],
    };
}

function emptyFinance(): FinanceSummary {
    return { donationTotal: 0, expenseTotal: 0, balance: 0, donationCount: 0, expenseCount: 0, byCategory: [] };
}

async function summarizeFinance(c: AppContext, reportId: number, periodStart?: string, periodEnd?: string): Promise<FinanceSummary> {
    const conditions = [eq(financeTransactions.status, "confirmed"), eq(financeTransactions.reportId, reportId)];
    if (periodStart && periodEnd) {
        conditions.push(gte(financeTransactions.occurredAt, periodStart), lte(financeTransactions.occurredAt, periodEnd));
    }
    const rows = await c.get("db").query.financeTransactions.findMany({
        where: and(...conditions),
        orderBy: [desc(financeTransactions.occurredAt)],
    });
    const summary = emptyFinance();
    const categories = new Map<string, number>();
    for (const row of rows) {
        if (row.type === "donation") {
            summary.donationTotal += row.amount;
            summary.donationCount += 1;
        } else if (row.type === "expense") {
            summary.expenseTotal += row.amount;
            summary.expenseCount += 1;
            categories.set(row.category, (categories.get(row.category) || 0) + row.amount);
        }
    }
    summary.balance = summary.donationTotal - summary.expenseTotal;
    summary.byCategory = [...categories.entries()]
        .map(([category, amount]) => ({ category, amount }))
        .sort((a, b) => b.amount - a.amount);
    return summary;
}

async function buildMetrics(c: AppContext, periodStart: string, periodEnd: string): Promise<SharingReportMetrics> {
    const { from, to } = dateRange(periodStart, periodEnd);
    const periodFeeds = await c.get("db").query.feeds.findMany({
        where: and(gte(feeds.createdAt, from), lte(feeds.createdAt, to)),
        columns: { content: true, draft: true, listed: true },
    });
    const imageReferences = periodFeeds.reduce((total, feed) => total + (feed.content.match(IMAGE_PATTERN) || []).length, 0);
    const publishedArticles = periodFeeds.filter((feed) => feed.draft === 0 && feed.listed === 1).length;
    const viewRows = await c.get("db").select({ pageViews: sql<number>`COALESCE(SUM(${analyticsDaily.pv}), 0)` })
        .from(analyticsDaily)
        .where(and(gte(analyticsDaily.date, periodStart), lte(analyticsDaily.date, periodEnd)));
    // media_assets 在 0013/0014 迁移里没有 file_size 列（Stage 1 旧模型才有），
    // 对不存在的列做 SUM 会在 D1 直接 500。storageBytes 暂时记 0，
    // 待 file_size 列 + 迁移补上后再恢复真实聚合。
    return {
        imageReferences,
        publishedArticles,
        pageViews: Number(viewRows[0]?.pageViews) || 0,
        storageBytes: 0,
    };
}

function toReport(row: typeof sharingReports.$inferSelect, financeOverride?: FinanceSummary) {
    return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        goals: row.goals,
        summary: row.summary,
        status: row.status as "draft" | "published",
        metrics: parseJson<SharingReportMetrics>(row.metricsJson, { imageReferences: 0, publishedArticles: 0, pageViews: 0, storageBytes: 0 }),
        finance: financeOverride || parseJson<FinanceSummary>(row.financeJson, emptyFinance()),
        publishedAt: row.publishedAt?.toISOString() || null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

export function SharingReportService() {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();

    app.get("/published", async (c) => {
        const rows = await c.get("db").query.sharingReports.findMany({
            where: eq(sharingReports.status, "published"),
            orderBy: [desc(sharingReports.publishedAt)],
        });
        return c.json(rows.map((row) => toReport(row)));
    });

    app.get("/published/:slug", async (c) => {
        const row = await c.get("db").query.sharingReports.findFirst({
            where: and(eq(sharingReports.slug, c.req.param("slug")), eq(sharingReports.status, "published")),
        });
        if (!row) throw new NotFoundError("Sharing report");
        return c.json(toReport(row));
    });

    app.get("/", adminOnly(async (c) => {
        const rows = await c.get("db").query.sharingReports.findMany({ orderBy: [desc(sharingReports.periodEnd)] });
        return c.json(await Promise.all(rows.map(async (row) => toReport(row, await summarizeFinance(c, row.id)))));
    }, { message: "Permission denied", status: 403 }));

    app.post("/", adminOnly(async (c) => {
        const body = await c.req.json() as Partial<CreateSharingReportRequest>;
        const title = body.title?.trim();
        if (!title) throw new BadRequestError("title is required");
        const periodStart = parseDate(body.periodStart, "periodStart");
        const periodEnd = parseDate(body.periodEnd, "periodEnd");
        dateRange(periodStart, periodEnd);
        const [row] = await c.get("db").insert(sharingReports).values({
            slug: slugFromTitle(title),
            title,
            periodStart,
            periodEnd,
            goals: body.goals?.trim() || "",
            summary: body.summary?.trim() || "",
        }).returning();
        return c.json(toReport(row), 201);
    }, { message: "Permission denied", status: 403 }));

    app.get("/:id", adminOnly(async (c) => {
        const id = Number(c.req.param("id"));
        const row = await c.get("db").query.sharingReports.findFirst({ where: eq(sharingReports.id, id) });
        if (!row) throw new NotFoundError("Sharing report");
        const transactions = await c.get("db").query.financeTransactions.findMany({
            where: eq(financeTransactions.reportId, id),
            orderBy: [desc(financeTransactions.occurredAt), desc(financeTransactions.id)],
        });
        return c.json({ report: toReport(row, await summarizeFinance(c, id)), transactions: transactions.map(toTransaction) });
    }, { message: "Permission denied", status: 403 }));

    app.patch("/:id", adminOnly(async (c) => {
        const id = Number(c.req.param("id"));
        const body = await c.req.json() as Partial<CreateSharingReportRequest> & { status?: "draft" | "published" };
        const existing = await c.get("db").query.sharingReports.findFirst({ where: eq(sharingReports.id, id) });
        if (!existing) throw new NotFoundError("Sharing report");
        const values: Partial<typeof sharingReports.$inferInsert> = { updatedAt: new Date() };
        if (body.title !== undefined) values.title = body.title.trim();
        if (body.goals !== undefined) values.goals = body.goals.trim();
        if (body.summary !== undefined) values.summary = body.summary.trim();
        if (body.periodStart !== undefined) values.periodStart = parseDate(body.periodStart, "periodStart");
        if (body.periodEnd !== undefined) values.periodEnd = parseDate(body.periodEnd, "periodEnd");
        if (values.periodStart || values.periodEnd) dateRange(values.periodStart || existing.periodStart, values.periodEnd || existing.periodEnd);
        if (body.status === "draft") values.status = "draft";
        if (body.status === "published") {
            values.status = "published";
            values.publishedAt = existing.publishedAt || new Date();
            values.metricsJson = JSON.stringify(await buildMetrics(c, values.periodStart || existing.periodStart, values.periodEnd || existing.periodEnd));
            values.financeJson = JSON.stringify(await summarizeFinance(c, id, values.periodStart || existing.periodStart, values.periodEnd || existing.periodEnd));
        }
        const [row] = await c.get("db").update(sharingReports).set(values).where(eq(sharingReports.id, id)).returning();
        return c.json(toReport(row, await summarizeFinance(c, id)));
    }, { message: "Permission denied", status: 403 }));

    app.post("/:id/snapshot", adminOnly(async (c) => {
        const id = Number(c.req.param("id"));
        const row = await c.get("db").query.sharingReports.findFirst({ where: eq(sharingReports.id, id) });
        if (!row) throw new NotFoundError("Sharing report");
        const metrics = await buildMetrics(c, row.periodStart, row.periodEnd);
        const finance = await summarizeFinance(c, id, row.periodStart, row.periodEnd);
        const [updated] = await c.get("db").update(sharingReports).set({
            metricsJson: JSON.stringify(metrics),
            financeJson: JSON.stringify(finance),
            updatedAt: new Date(),
        }).where(eq(sharingReports.id, id)).returning();
        return c.json(toReport(updated, finance));
    }, { message: "Permission denied", status: 403 }));

    app.post("/transactions", adminOnly(async (c) => {
        const body = await c.req.json() as Partial<CreateFinanceTransactionRequest>;
        if (body.type !== "donation" && body.type !== "expense") throw new BadRequestError("type must be donation or expense");
        if (!body.title?.trim() || !body.category?.trim()) throw new BadRequestError("title and category are required");
        const amount = Math.round(Number(body.amount));
        if (!Number.isSafeInteger(amount) || amount <= 0) throw new BadRequestError("amount must be a positive integer in minor currency units");
        const occurredAt = parseDate(body.occurredAt, "occurredAt");
        const [row] = await c.get("db").insert(financeTransactions).values({
            reportId: body.reportId ?? null,
            type: body.type,
            category: body.category.trim(),
            title: body.title.trim(),
            description: body.description?.trim() || "",
            amount,
            currency: body.currency?.trim().toUpperCase() || "CNY",
            occurredAt,
            receiptUrl: body.receiptUrl?.trim() || "",
            isAnonymous: body.isAnonymous === false ? 0 : 1,
        }).returning();
        return c.json(toTransaction(row), 201);
    }, { message: "Permission denied", status: 403 }));

    app.patch("/transactions/:id", adminOnly(async (c) => {
        const id = Number(c.req.param("id"));
        const body = await c.req.json() as Partial<CreateFinanceTransactionRequest> & { status?: "confirmed" | "voided" };
        const values: Partial<typeof financeTransactions.$inferInsert> = { updatedAt: new Date() };
        if (body.type !== undefined) {
            if (body.type !== "donation" && body.type !== "expense") throw new BadRequestError("invalid transaction type");
            values.type = body.type;
        }
        if (body.amount !== undefined) {
            const amount = Math.round(Number(body.amount));
            if (!Number.isSafeInteger(amount) || amount <= 0) throw new BadRequestError("amount must be a positive integer in minor currency units");
            values.amount = amount;
        }
        if (body.category !== undefined) values.category = body.category.trim();
        if (body.title !== undefined) values.title = body.title.trim();
        if (body.description !== undefined) values.description = body.description.trim();
        if (body.occurredAt !== undefined) values.occurredAt = parseDate(body.occurredAt, "occurredAt");
        if (body.reportId !== undefined) values.reportId = body.reportId;
        if (body.receiptUrl !== undefined) values.receiptUrl = body.receiptUrl.trim();
        if (body.isAnonymous !== undefined) values.isAnonymous = body.isAnonymous ? 1 : 0;
        if (body.status !== undefined) values.status = body.status;
        const [row] = await c.get("db").update(financeTransactions).set(values).where(eq(financeTransactions.id, id)).returning();
        if (!row) throw new NotFoundError("Finance transaction");
        return c.json(toTransaction(row));
    }, { message: "Permission denied", status: 403 }));

    return app;
}
