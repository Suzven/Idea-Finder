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
import { addFavorite, closeDatabase, getFavoriteIds, healthcheckDatabase, removeFavorite } from "./db.js";
import { filterAds } from "./services/filterAds.js";
import type { AdFilters, AdSource, AdsResponse } from "../src/shared/types.js";

const app = express();
if (config.trustProxy) app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: "100kb" }));

const querySchema = z.object({
  source: z.enum(["meta", "tiktok"]).default("meta"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  search: z.string().max(100).optional(),
  searchMode: z.enum(["all", "exact", "media"]).optional(),
  country: z.string().max(3).optional(),
  app: z.string().max(250).optional(),
  mediaType: z.enum(["all", "image", "video", "carousel"]).optional(),
  language: z.string().max(10).optional(),
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

const favoriteSchema = z.object({ source: z.enum(["meta", "tiktok"]) });

app.post("/api/favorites/:adId", async (request, response, next) => {
  try {
    const { source } = favoriteSchema.parse(request.body);
    await addFavorite(getClientId(request), request.params.adId, source);
    response.status(201).json({ ok: true });
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
  response.status(error instanceof z.ZodError ? 400 : 502).json({ error: message });
});

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`SpyService API: http://localhost:${config.port} (${config.apiMode})`);
});

async function shutdown(): Promise<void> {
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
