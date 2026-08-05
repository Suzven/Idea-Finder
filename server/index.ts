import compression from "compression";
import express from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fetchMetaAds } from "./adapters/meta.js";
import { fetchTikTokAds } from "./adapters/tiktok.js";
import { config } from "./config.js";
import { demoAds } from "./data/demoAds.js";
import { addFavorite, clearIntegrationLogs, closeDatabase, createCollection, deleteAIAnalysisReport, deleteCollection, deleteExpiredIntegrationLogs, getAIAnalysisLandingScreenshot, getAIAnalysisReport, getAIAnalysisReports, getCollections, getFavoriteAds, getFavoriteIds, getIntegrationLogById, getIntegrationLogs, healthcheckDatabase, removeFavorite, saveAIAnalysisReport, setCreativeAnalysisNotes } from "./db.js";
import { AppError } from "./errors.js";
import { filterAds } from "./services/filterAds.js";
import { getMetaMedia, registerMetaAd, streamMetaMedia } from "./services/metaSnapshot.js";
import { analyzeCollection } from "./services/aiAnalysis.js";
import { searchCompanyReviews } from "./services/reviewAnalysis.js";
import type { AdFilters, AdSource, AdsResponse, AIAnalysisJobError, AIAnalysisJobResponse, AIAnalysisResponse, ReviewSearchJobResponse, ReviewSearchResponse, ReviewSource } from "../src/shared/types.js";

const app = express();
if (config.trustProxy) app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: "100kb" }));

interface StoredAIAnalysisJob {
  jobId: string;
  clientId: string;
  collectionId: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  result?: AIAnalysisResponse;
  error?: AIAnalysisJobError;
}

const aiAnalysisJobs = new Map<string, StoredAIAnalysisJob>();
interface StoredReviewSearchJob {
  jobId: string;
  clientId: string;
  query: string;
  sources: ReviewSource[];
  status: "queued" | "running" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  result?: ReviewSearchResponse;
  error?: AIAnalysisJobError;
}

const reviewSearchJobs = new Map<string, StoredReviewSearchJob>();
const AI_JOB_TTL_MS = 30 * 60_000;
const MAX_ACTIVE_AI_JOBS = 2;
const MAX_ACTIVE_REVIEW_JOBS = 2;

function publicAIJob(job: StoredAIAnalysisJob): AIAnalysisJobResponse {
  return {
    jobId: job.jobId,
    status: job.status,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function publicReviewJob(job: StoredReviewSearchJob): ReviewSearchJobResponse {
  return {
    jobId: job.jobId,
    status: job.status,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function backgroundJobError(error: unknown, traceId: string): AIAnalysisJobError {
  if (error instanceof AppError) {
    return {
      message: error.message,
      code: error.code,
      httpStatus: error.status,
      action: error.action,
      traceId,
      details: error.details,
    };
  }
  return {
    message: error instanceof Error ? error.message : "Неизвестная ошибка AI-анализа.",
    code: "AI_ANALYSIS_FAILED",
    httpStatus: 502,
    traceId,
  };
}

function parseList(value: unknown): unknown {
  if (value === undefined || value === "") return undefined;
  const rawValues = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(rawValues.map((item) => String(item).trim()).filter(Boolean))];
}

const querySchema = z.object({
  source: z.enum(["meta", "tiktok"]).default("meta"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  search: z.string().max(100).optional(),
  searchMode: z.enum(["all", "exact", "media"]).optional(),
  country: z.preprocess(parseList, z.array(z.string().regex(/^(?:ALL|[A-Z]{2})$/)).max(250).optional()),
  app: z.string().max(250).optional(),
  mediaType: z.enum(["all", "image", "video", "carousel"]).optional(),
  language: z.preprocess(parseList, z.array(z.string().regex(/^[a-z]{2,3}$/)).max(200).optional()),
  dateFrom: z.string().max(10).optional(),
  dateTo: z.string().max(10).optional(),
  platform: z.string().max(40).optional(),
  reachFrom: z.string().max(20).optional(),
  reachTo: z.string().max(20).optional(),
  advertiser: z.string().max(100).optional(),
  durationFrom: z.string().max(10).optional(),
  durationTo: z.string().max(10).optional(),
  savedFrom: z.string().max(10).optional(),
  savedTo: z.string().max(10).optional(),
});

const adCreativeSchema = z.object({
  id: z.string().min(1).max(160),
  source: z.enum(["meta", "tiktok"]),
  advertiser: z.string().max(2_000),
  advertiserAvatar: z.string().max(5_000).optional(),
  country: z.string().max(20),
  countryName: z.string().max(500),
  countries: z.array(z.string().max(120)).max(250).optional(),
  platforms: z.array(z.string().max(80)).max(20),
  mediaType: z.enum(["image", "video", "carousel"]),
  mediaUrl: z.string().max(5_000),
  thumbnailUrl: z.string().max(5_000),
  mediaInfoUrl: z.string().max(5_000).optional(),
  carousel: z.array(z.string().max(5_000)).max(50).optional(),
  headline: z.string().max(20_000),
  body: z.string().max(50_000),
  cta: z.string().max(1_000),
  landingUrl: z.string().max(5_000).optional(),
  sourceUrl: z.string().max(5_000).optional(),
  startedAt: z.string().max(50),
  endedAt: z.string().max(50).optional(),
  daysActive: z.number().finite().nonnegative(),
  reach: z.number().finite().nonnegative().optional(),
  savedCount: z.number().finite().nonnegative(),
  language: z.string().max(20),
  appUrl: z.string().max(5_000).optional(),
  isFavorite: z.boolean().optional(),
});

function getClientId(request: express.Request): string {
  return String(request.header("x-client-id") ?? "anonymous").slice(0, 100);
}

function shouldUseLive(source: AdSource): boolean {
  if (config.apiMode === "demo") return false;
  if (config.apiMode === "live") return true;
  return source === "meta" ? Boolean(config.metaAccessToken) : Boolean(config.tiktokAccessToken);
}

app.get("/api/health", async (_request, response) => {
  response.json({ status: "ok", apiMode: config.apiMode, database: await healthcheckDatabase() });
});

const logQuerySchema = z.object({
  provider: z.enum(["meta", "tiktok"]).optional(),
  status: z.enum(["started", "success", "error"]).optional(),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

app.get("/api/integration-logs", async (request, response, next) => {
  try {
    response.json(await getIntegrationLogs(logQuerySchema.parse(request.query)));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/integration-logs", async (_request, response, next) => {
  try {
    const deleted = await clearIntegrationLogs();
    if (deleted === null) throw new AppError(503, "DATABASE_DISABLED", "База данных не подключена.");
    response.json({ ok: true, deleted });
  } catch (error) {
    next(error);
  }
});

app.get("/api/integration-logs/:id", async (request, response, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const log = await getIntegrationLogById(id);
    if (!log) throw new AppError(404, "INTEGRATION_LOG_NOT_FOUND", "Лог не найден или база данных не подключена.");
    response.json(log);
  } catch (error) {
    next(error);
  }
});

app.get("/api/ads", async (request, response, next) => {
  try {
    const query = querySchema.parse(request.query);
    const { source, cursor, limit, ...filters } = query;
    let result: AdsResponse;

    if (shouldUseLive(source)) {
      result = source === "meta"
        ? await fetchMetaAds(filters as Partial<AdFilters>, cursor, limit)
        : await fetchTikTokAds(filters as Partial<AdFilters>, cursor, limit);
    } else {
      const matched = filterAds(demoAds[source], filters as Partial<AdFilters>);
      const offset = Math.max(0, Number(cursor ?? 0) || 0);
      const items = matched.slice(offset, offset + limit);
      result = {
        items,
        nextCursor: offset + limit < matched.length ? String(offset + limit) : null,
        total: matched.length,
        mode: "demo",
      };
    }

    const favorites = await getFavoriteIds(getClientId(request));
    result.items = result.items.map((ad) => ({ ...ad, isFavorite: favorites.has(ad.id) }));
    response.json(result);
  } catch (error) {
    next(error);
  }
});

const collectionIdSchema = z.string().regex(/^\d+$/);
const favoriteSchema = z.object({
  source: z.enum(["meta", "tiktok"]),
  ad: adCreativeSchema,
  collectionId: collectionIdSchema.nullish(),
});
const favoriteQuerySchema = z.object({ collectionId: collectionIdSchema.optional() });
const createCollectionSchema = z.object({ name: z.string().trim().min(1).max(120) });
const analyzeCollectionSchema = z.object({ collectionId: collectionIdSchema });
const aiNoteSchema = z.object({
  collectionId: collectionIdSchema,
  adIds: z.array(z.string().min(1).max(160)).min(1).max(100),
  note: z.string().trim().max(1000),
});
const reviewSearchSchema = z.object({
  query: z.string().trim().min(2).max(120),
  sources: z.array(z.enum(["trustpilot", "g2"])).min(1).max(10),
});

function snapshotUrlFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>).ad_snapshot_url;
  return typeof value === "string" ? value : undefined;
}

app.get("/api/favorites", async (request, response, next) => {
  try {
    const { collectionId } = favoriteQuerySchema.parse(request.query);
    const stored = await getFavoriteAds(getClientId(request), collectionId);
    const items = stored.map(({ ad, sourcePayload }) => {
      if (ad.source !== "meta") return { ...ad, isFavorite: true };
      const externalId = ad.id.replace(/^meta-/, "");
      const snapshotUrl = snapshotUrlFromPayload(sourcePayload);
      const mediaInfoUrl = snapshotUrl ? registerMetaAd(externalId, snapshotUrl) : ad.mediaInfoUrl;
      return { ...ad, mediaInfoUrl, isFavorite: true };
    });
    response.json({ items, nextCursor: null, total: items.length, mode: "live" } satisfies AdsResponse);
  } catch (error) {
    next(error);
  }
});

app.post("/api/favorites/:adId", async (request, response, next) => {
  try {
    const { source, ad, collectionId } = favoriteSchema.parse(request.body);
    if (ad.id !== request.params.adId || ad.source !== source) {
      throw new AppError(400, "FAVORITE_AD_MISMATCH", "Данные сохраняемого объявления не совпадают с адресом запроса.");
    }
    const saved = await addFavorite(getClientId(request), ad, collectionId ?? undefined);
    if (!saved) throw new AppError(404, "COLLECTION_NOT_FOUND", "Коллекция не найдена.");
    response.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/collections", async (request, response, next) => {
  try {
    response.json({ items: await getCollections(getClientId(request)) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/collections", async (request, response, next) => {
  try {
    const { name } = createCollectionSchema.parse(request.body);
    response.status(201).json(await createCollection(getClientId(request), name));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/collections/:collectionId", async (request, response, next) => {
  try {
    const collectionId = collectionIdSchema.parse(request.params.collectionId);
    const deletedFavorites = await deleteCollection(getClientId(request), collectionId);
    if (deletedFavorites === null) throw new AppError(404, "COLLECTION_NOT_FOUND", "Коллекция не найдена.");
    response.json({ ok: true, deletedFavorites });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai-analysis", async (request, response, next) => {
  try {
    const apiKey = String(request.header("x-openai-api-key") ?? "").trim();
    if (!apiKey || apiKey.length > 500) {
      throw new AppError(400, "OPENAI_KEY_REQUIRED", "Добавьте OpenAI API-ключ в Настройках.");
    }
    const { collectionId } = analyzeCollectionSchema.parse(request.body);
    const clientId = getClientId(request);
    const collection = (await getCollections(clientId)).find((item) => item.id === collectionId);
    if (!collection) throw new AppError(404, "COLLECTION_NOT_FOUND", "Коллекция не найдена.");
    const items = await getFavoriteAds(clientId, collectionId);
    if (!items.length) throw new AppError(400, "COLLECTION_EMPTY", "В коллекции нет креативов для анализа.");
    const existing = [...aiAnalysisJobs.values()].find((job) =>
      job.clientId === clientId
      && job.collectionId === collectionId
      && (job.status === "queued" || job.status === "running"));
    if (existing) {
      response.status(202).json(publicAIJob(existing));
      return;
    }
    const activeCount = [...aiAnalysisJobs.values()].filter((job) => job.status === "queued" || job.status === "running").length;
    if (activeCount >= MAX_ACTIVE_AI_JOBS) {
      throw new AppError(429, "AI_ANALYSIS_BUSY", "Сервер уже выполняет максимальное количество AI-анализов.", "Подождите завершения текущих задач и повторите запрос.");
    }

    const now = Date.now();
    const job: StoredAIAnalysisJob = {
      jobId: randomUUID(),
      clientId,
      collectionId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    aiAnalysisJobs.set(job.jobId, job);
    response.status(202).json(publicAIJob(job));

    void (async () => {
      job.status = "running";
      job.updatedAt = Date.now();
      try {
        const prepared = await analyzeCollection({ apiKey, clientId, collection, items });
        const report = await saveAIAnalysisReport(clientId, collection, prepared.response, prepared.landingAssets);
        job.result = report.result;
        job.status = "completed";
      } catch (error) {
        job.status = "failed";
        job.error = backgroundJobError(error, job.jobId);
        console.error(`[${job.jobId}] AI analysis background job failed`, error);
      } finally {
        job.updatedAt = Date.now();
      }
    })();
  } catch (error) {
    next(error);
  }
});

app.get("/api/ai-analysis/creatives/:collectionId", async (request, response, next) => {
  try {
    const collectionId = collectionIdSchema.parse(request.params.collectionId);
    const clientId = getClientId(request);
    const collection = (await getCollections(clientId)).find((item) => item.id === collectionId);
    if (!collection) throw new AppError(404, "COLLECTION_NOT_FOUND", "Коллекция не найдена.");
    const items = (await getFavoriteAds(clientId, collectionId)).map(({ ad, analysisNote }) => ({
      ad,
      note: analysisNote ?? "",
    }));
    response.json({ items });
  } catch (error) {
    next(error);
  }
});

app.put("/api/ai-analysis/creative-notes", async (request, response, next) => {
  try {
    const { collectionId, adIds, note } = aiNoteSchema.parse(request.body);
    const updated = await setCreativeAnalysisNotes(getClientId(request), collectionId, adIds, note);
    if (!updated) throw new AppError(404, "CREATIVES_NOT_FOUND", "Выбранные креативы не найдены в коллекции.");
    response.json({ ok: true, updated });
  } catch (error) {
    next(error);
  }
});

app.get("/api/ai-analysis/reports", async (request, response, next) => {
  try {
    response.json({ items: await getAIAnalysisReports(getClientId(request)) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/ai-analysis/reports/:reportId", async (request, response, next) => {
  try {
    const reportId = collectionIdSchema.parse(request.params.reportId);
    const report = await getAIAnalysisReport(getClientId(request), reportId);
    if (!report) throw new AppError(404, "AI_REPORT_NOT_FOUND", "Сохранённый AI-отчёт не найден.");
    response.json(report);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/ai-analysis/reports/:reportId", async (request, response, next) => {
  try {
    const reportId = collectionIdSchema.parse(request.params.reportId);
    if (!await deleteAIAnalysisReport(getClientId(request), reportId)) {
      throw new AppError(404, "AI_REPORT_NOT_FOUND", "Сохранённый AI-отчёт не найден.");
    }
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/ai-analysis/landing-screenshots/:token", async (request, response, next) => {
  try {
    const token = z.string().uuid().parse(request.params.token);
    const screenshot = await getAIAnalysisLandingScreenshot(token);
    if (!screenshot) throw new AppError(404, "AI_LANDING_SCREENSHOT_NOT_FOUND", "Скриншот лендинга не найден.");
    response.set({
      "Content-Type": screenshot.mimeType,
      "Content-Length": String(screenshot.buffer.length),
      "Cache-Control": "private, max-age=86400, immutable",
    });
    response.send(screenshot.buffer);
  } catch (error) {
    next(error);
  }
});

app.get("/api/ai-analysis/jobs/:jobId", (request, response, next) => {
  try {
    const jobId = z.string().uuid().parse(request.params.jobId);
    const job = aiAnalysisJobs.get(jobId);
    if (!job || job.clientId !== getClientId(request)) {
      throw new AppError(404, "AI_ANALYSIS_JOB_NOT_FOUND", "Задача AI-анализа не найдена или уже удалена.");
    }
    response.json(publicAIJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/review-analysis", (request, response, next) => {
  try {
    const parsed = reviewSearchSchema.parse(request.body);
    const query = parsed.query.trim();
    const sources = [...new Set(parsed.sources)] as ReviewSource[];
    const clientId = getClientId(request);
    const sourceKey = [...sources].sort().join(",");
    const existing = [...reviewSearchJobs.values()].find((job) =>
      job.clientId === clientId
      && job.query.toLowerCase() === query.toLowerCase()
      && [...job.sources].sort().join(",") === sourceKey
      && (job.status === "queued" || job.status === "running"));
    if (existing) {
      response.status(202).json(publicReviewJob(existing));
      return;
    }
    const activeCount = [...reviewSearchJobs.values()].filter((job) => job.status === "queued" || job.status === "running").length;
    if (activeCount >= MAX_ACTIVE_REVIEW_JOBS) {
      throw new AppError(429, "REVIEW_ANALYSIS_BUSY", "Сервер уже выполняет максимальное количество поисков отзывов.", "Дождитесь завершения текущих задач и повторите запрос.");
    }

    const now = Date.now();
    const job: StoredReviewSearchJob = {
      jobId: randomUUID(),
      clientId,
      query,
      sources,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    reviewSearchJobs.set(job.jobId, job);
    response.status(202).json(publicReviewJob(job));

    void (async () => {
      job.status = "running";
      job.updatedAt = Date.now();
      try {
        job.result = await searchCompanyReviews(query, sources);
        job.status = "completed";
      } catch (error) {
        job.status = "failed";
        job.error = backgroundJobError(error, job.jobId);
        console.error(`[${job.jobId}] review analysis background job failed`, error);
      } finally {
        job.updatedAt = Date.now();
      }
    })();
  } catch (error) {
    next(error);
  }
});

app.get("/api/review-analysis/jobs/:jobId", (request, response, next) => {
  try {
    const jobId = z.string().uuid().parse(request.params.jobId);
    const job = reviewSearchJobs.get(jobId);
    if (!job || job.clientId !== getClientId(request)) {
      throw new AppError(404, "REVIEW_ANALYSIS_JOB_NOT_FOUND", "Задача поиска отзывов не найдена или уже удалена.");
    }
    response.json(publicReviewJob(job));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/favorites/:adId", async (request, response, next) => {
  try {
    await removeFavorite(getClientId(request), request.params.adId);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/meta/media/:adId", async (request, response, next) => {
  try {
    response.json(await getMetaMedia(request.params.adId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/meta/media/:adId/:variant", async (request, response, next) => {
  try {
    const variant = z.enum(["content", "thumbnail", "avatar"]).parse(request.params.variant);
    await streamMetaMedia(request.params.adId, variant, request, response);
  } catch (error) {
    next(error);
  }
});

const currentDir = dirname(fileURLToPath(import.meta.url));
const staticDir = join(currentDir, "../../dist");
if (existsSync(staticDir)) {
  app.use(express.static(staticDir, { maxAge: "7d", index: false }));
  app.get("/{*splat}", (_request, response) => response.sendFile(join(staticDir, "index.html")));
}

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const traceId = randomUUID();
  const message = error instanceof z.ZodError
    ? "Некорректные параметры запроса"
    : error instanceof Error ? error.message : "Неизвестная ошибка";
  console.error(`[${traceId}]`, error);
  if (error instanceof AppError) {
    response.status(error.status).json({
      error: message,
      code: error.code,
      traceId,
      ...(error.action ? { action: error.action } : {}),
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  response.status(error instanceof z.ZodError ? 400 : 502).json({
    error: message,
    code: error instanceof z.ZodError ? "INVALID_REQUEST" : "INTERNAL_ERROR",
    traceId,
  });
});

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`SpyService API: http://localhost:${config.port} (${config.apiMode})`);
});

const LOG_CLEANUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
void deleteExpiredIntegrationLogs(7);
const logCleanupTimer = setInterval(() => { void deleteExpiredIntegrationLogs(7); }, LOG_CLEANUP_INTERVAL_MS);
logCleanupTimer.unref();
const aiJobCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - AI_JOB_TTL_MS;
  for (const [jobId, job] of aiAnalysisJobs) {
    if (job.updatedAt < cutoff && job.status !== "queued" && job.status !== "running") aiAnalysisJobs.delete(jobId);
  }
  for (const [jobId, job] of reviewSearchJobs) {
    if (job.updatedAt < cutoff && job.status !== "queued" && job.status !== "running") reviewSearchJobs.delete(jobId);
  }
}, 5 * 60_000);
aiJobCleanupTimer.unref();

async function shutdown(): Promise<void> {
  clearInterval(logCleanupTimer);
  clearInterval(aiJobCleanupTimer);
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
