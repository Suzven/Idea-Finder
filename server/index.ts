import compression from "compression";
import express from "express";
import helmet from "helmet";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fetchMetaAds } from "./adapters/meta.js";
import { fetchTikTokAds } from "./adapters/tiktok.js";
import { config } from "./config.js";
import { demoAds } from "./data/demoAds.js";
import { addFavorite, clearIntegrationLogs, closeDatabase, createCollection, deleteExpiredIntegrationLogs, getCollections, getFavoriteAds, getFavoriteIds, getIntegrationLogById, getIntegrationLogs, healthcheckDatabase, removeFavorite } from "./db.js";
import { AppError } from "./errors.js";
import { filterAds } from "./services/filterAds.js";
import { getMetaMedia, registerMetaAd, streamMetaMedia } from "./services/metaSnapshot.js";
import type { AdFilters, AdSource, AdsResponse } from "../src/shared/types.js";

const app = express();
if (config.trustProxy) app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: "100kb" }));

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
  const message = error instanceof z.ZodError
    ? "Некорректные параметры запроса"
    : error instanceof Error ? error.message : "Неизвестная ошибка";
  console.error(error);
  if (error instanceof AppError) {
    response.status(error.status).json({
      error: message,
      code: error.code,
      ...(error.action ? { action: error.action } : {}),
    });
    return;
  }
  response.status(error instanceof z.ZodError ? 400 : 502).json({ error: message });
});

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`SpyService API: http://localhost:${config.port} (${config.apiMode})`);
});

const LOG_CLEANUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
void deleteExpiredIntegrationLogs(7);
const logCleanupTimer = setInterval(() => { void deleteExpiredIntegrationLogs(7); }, LOG_CLEANUP_INTERVAL_MS);
logCleanupTimer.unref();

async function shutdown(): Promise<void> {
  clearInterval(logCleanupTimer);
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
