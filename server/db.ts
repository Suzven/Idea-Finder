import mysql from "mysql2/promise";
import { config } from "./config.js";
import type { AdCreative, AdSource, CreativeCollection, IntegrationLogDetail, IntegrationLogsResponse, IntegrationLogStatus, IntegrationLogSummary } from "../src/shared/types.js";

const databaseConfig = config.database;
const databaseConfigured = Boolean(
  databaseConfig?.host && databaseConfig.name && databaseConfig.user && databaseConfig.password,
);

const pool = databaseConfigured
  ? mysql.createPool({
      host: databaseConfig.host,
      port: databaseConfig.port,
      database: databaseConfig.name,
      user: databaseConfig.user,
      password: databaseConfig.password,
      charset: "utf8mb4",
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    })
  : null;
const memoryFavorites = new Map<string, Set<string>>();
const memoryFavoriteAds = new Map<string, Map<string, AdCreative>>();
const memoryCollections = new Map<string, Map<string, CreativeCollection>>();
const memoryFavoriteCollections = new Map<string, Map<string, Set<string>>>();
let memoryCollectionId = 0;

export interface CollectedAdEntry {
  ad: AdCreative;
  sourcePayload?: unknown;
}

export interface StoredFavorite {
  ad: AdCreative;
  sourcePayload?: unknown;
}

export interface IntegrationLogStart {
  traceId: string;
  provider: "meta" | "tiktok";
  operation: string;
  requestMethod: string;
  requestUrl: string;
  requestHeaders?: string;
  requestBody?: string;
}

export interface IntegrationLogFinish {
  status: "success" | "error";
  responseStatus?: number;
  responseHeaders?: string;
  responseBody?: string;
  parseAttempts?: string;
  errorMessage?: string;
  durationMs: number;
}

export async function createIntegrationLog(entry: IntegrationLogStart): Promise<number | null> {
  if (!pool) return null;
  try {
    const [result] = await pool.execute<mysql.ResultSetHeader>(
      `INSERT INTO integration_logs
        (trace_id, provider, operation, status, request_method, request_url, request_headers, request_body)
       VALUES (?, ?, ?, 'started', ?, ?, ?, ?)`,
      [
        entry.traceId,
        entry.provider,
        entry.operation,
        entry.requestMethod,
        entry.requestUrl,
        entry.requestHeaders ?? null,
        entry.requestBody ?? null,
      ],
    );
    return result.insertId;
  } catch (error) {
    console.error("Не удалось создать integration log:", error);
    return null;
  }
}

export async function finishIntegrationLog(id: number | null, entry: IntegrationLogFinish): Promise<void> {
  if (!pool || id === null) return;
  try {
    await pool.execute(
      `UPDATE integration_logs
       SET status = ?, response_status = ?, response_headers = ?, response_body = ?,
           parse_attempts = ?, error_message = ?, duration_ms = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        entry.status,
        entry.responseStatus ?? null,
        entry.responseHeaders ?? null,
        entry.responseBody ?? null,
        entry.parseAttempts ?? null,
        entry.errorMessage ?? null,
        entry.durationMs,
        id,
      ],
    );
  } catch (error) {
    console.error("Не удалось завершить integration log:", error);
  }
}

export async function deleteExpiredIntegrationLogs(retentionDays = 7): Promise<void> {
  if (!pool) return;
  const safeRetentionDays = Math.max(1, Math.floor(retentionDays));
  try {
    await pool.execute(
      `DELETE FROM integration_logs
       WHERE created_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${safeRetentionDays} DAY)`,
    );
  } catch (error) {
    console.error("Не удалось очистить устаревшие integration logs:", error);
  }
}

export async function clearIntegrationLogs(): Promise<number | null> {
  if (!pool) return null;
  const [result] = await pool.execute<mysql.ResultSetHeader>("DELETE FROM integration_logs");
  return result.affectedRows;
}

export interface IntegrationLogQuery {
  provider?: AdSource;
  status?: IntegrationLogStatus;
  search?: string;
  limit: number;
  offset: number;
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : typeof value === "string" ? value : JSON.stringify(value);
}

function mapIntegrationLogSummary(row: mysql.RowDataPacket): IntegrationLogSummary {
  return {
    id: Number(row.id),
    traceId: String(row.trace_id),
    provider: row.provider as AdSource,
    operation: String(row.operation),
    status: row.status as IntegrationLogStatus,
    requestMethod: String(row.request_method),
    requestUrl: String(row.request_url),
    responseStatus: row.response_status === null ? null : Number(row.response_status),
    responsePreview: nullableString(row.response_preview),
    parseAttemptsCount: Number(row.parse_attempts_count ?? 0),
    errorMessage: nullableString(row.error_message),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    createdAt: toIsoString(row.created_at),
  };
}

function integrationLogConditions(query: IntegrationLogQuery): { sql: string; values: Array<string | number> } {
  const conditions: string[] = [];
  const values: Array<string | number> = [];
  if (query.provider) { conditions.push("provider = ?"); values.push(query.provider); }
  if (query.status) { conditions.push("status = ?"); values.push(query.status); }
  if (query.search) {
    conditions.push("(operation LIKE ? OR request_url LIKE ? OR error_message LIKE ? OR trace_id LIKE ?)");
    const value = `%${query.search}%`;
    values.push(value, value, value, value);
  }
  return { sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", values };
}

export async function getIntegrationLogs(query: IntegrationLogQuery): Promise<IntegrationLogsResponse> {
  if (!pool) {
    return { items: [], total: 0, databaseEnabled: false, stats: { success: 0, errors: 0, inProgress: 0, averageDurationMs: 0 } };
  }
  const where = integrationLogConditions(query);
  const [rows, aggregateRows] = await Promise.all([
    pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, trace_id, provider, operation, status, request_method, request_url,
              response_status, LEFT(response_body, 700) AS response_preview,
              COALESCE(JSON_LENGTH(parse_attempts), 0) AS parse_attempts_count,
              error_message, duration_ms, created_at
       FROM integration_logs
       ${where.sql}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...where.values, query.limit, query.offset],
    ),
    pool.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS total,
              SUM(status = 'success') AS success_count,
              SUM(status = 'error') AS error_count,
              SUM(status = 'started') AS started_count,
              COALESCE(AVG(duration_ms), 0) AS average_duration_ms
       FROM integration_logs
       ${where.sql}`,
      where.values,
    ),
  ]);
  const aggregate = aggregateRows[0][0] ?? {};
  return {
    items: rows[0].map(mapIntegrationLogSummary),
    total: Number(aggregate.total ?? 0),
    databaseEnabled: true,
    stats: {
      success: Number(aggregate.success_count ?? 0),
      errors: Number(aggregate.error_count ?? 0),
      inProgress: Number(aggregate.started_count ?? 0),
      averageDurationMs: Math.round(Number(aggregate.average_duration_ms ?? 0)),
    },
  };
}

export async function getIntegrationLogById(id: number): Promise<IntegrationLogDetail | null> {
  if (!pool) return null;
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT id, trace_id, provider, operation, status, request_method, request_url,
            request_headers, request_body, response_status, response_headers, response_body,
            LEFT(response_body, 700) AS response_preview,
            COALESCE(JSON_LENGTH(parse_attempts), 0) AS parse_attempts_count,
            parse_attempts, error_message, duration_ms, created_at, completed_at
     FROM integration_logs
     WHERE id = ?`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...mapIntegrationLogSummary(row),
    requestHeaders: nullableString(row.request_headers),
    requestBody: nullableString(row.request_body),
    responseHeaders: nullableString(row.response_headers),
    responseBody: nullableString(row.response_body),
    parseAttempts: nullableString(row.parse_attempts),
    completedAt: row.completed_at === null ? null : toIsoString(row.completed_at),
  };
}

export async function healthcheckDatabase(): Promise<"connected" | "disabled" | "unavailable"> {
  if (!pool) return "disabled";
  try {
    await pool.execute("SELECT 1");
    return "connected";
  } catch {
    return "unavailable";
  }
}

function externalAdId(ad: AdCreative): string {
  return ad.id.replace(/^(?:meta|tiktok)-/, "").slice(0, 128);
}

function mysqlDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 19).replace("T", " ");
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

async function writeCollectedAds(
  executor: Pick<mysql.Pool, "execute"> | Pick<mysql.PoolConnection, "execute">,
  entries: CollectedAdEntry[],
): Promise<void> {
  for (const { ad, sourcePayload } of entries) {
    await executor.execute(
      `INSERT INTO collected_ads
        (id, source, external_id, advertiser_name, country_code, media_type, started_at, ended_at, normalized_payload, source_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         advertiser_name = VALUES(advertiser_name), country_code = VALUES(country_code),
         media_type = VALUES(media_type), started_at = VALUES(started_at), ended_at = VALUES(ended_at),
         normalized_payload = VALUES(normalized_payload),
         source_payload = COALESCE(VALUES(source_payload), source_payload)`,
      [
        ad.id,
        ad.source,
        externalAdId(ad),
        ad.advertiser,
        ad.country.split("+")[0].slice(0, 3) || null,
        ad.mediaType,
        mysqlDate(ad.startedAt),
        mysqlDate(ad.endedAt),
        JSON.stringify(ad),
        sourcePayload === undefined ? null : JSON.stringify(sourcePayload),
      ],
    );
  }
}

export async function cacheCollectedAds(entries: CollectedAdEntry[]): Promise<void> {
  if (!pool || entries.length === 0) return;
  try {
    await writeCollectedAds(pool, entries);
  } catch (error) {
    console.error("Не удалось сохранить найденные объявления:", error);
  }
}

export async function getFavoriteIds(clientId: string): Promise<Set<string>> {
  if (!pool) return new Set(memoryFavorites.get(clientId) ?? []);
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT ad_id FROM favorites WHERE client_id = ?",
    [clientId],
  );
  return new Set(rows.map((row) => String(row.ad_id)));
}

export async function getFavoriteAds(clientId: string, collectionId?: string): Promise<StoredFavorite[]> {
  if (!pool) {
    const memberships = memoryFavoriteCollections.get(clientId);
    return [...(memoryFavoriteAds.get(clientId)?.values() ?? [])]
      .filter((ad) => !collectionId || memberships?.get(ad.id)?.has(collectionId))
      .map((ad) => ({ ad: { ...ad, isFavorite: true } }));
  }
  const collectionJoin = collectionId
    ? "INNER JOIN favorite_collections fc ON fc.client_id = f.client_id AND fc.ad_id = f.ad_id AND fc.collection_id = ?"
    : "";
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT c.normalized_payload, c.source_payload
     FROM favorites f
     ${collectionJoin}
     INNER JOIN collected_ads c ON c.id = f.ad_id
     WHERE f.client_id = ?
     ORDER BY f.created_at DESC`,
    collectionId ? [collectionId, clientId] : [clientId],
  );
  return rows.flatMap((row) => {
    const ad = parseJson(row.normalized_payload) as AdCreative | undefined;
    if (!ad?.id || !ad.source) return [];
    return [{ ad: { ...ad, isFavorite: true }, sourcePayload: parseJson(row.source_payload) }];
  });
}

export async function getCollections(clientId: string): Promise<CreativeCollection[]> {
  if (!pool) return [...(memoryCollections.get(clientId)?.values() ?? [])];
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT c.id, c.name, c.created_at, COUNT(fc.ad_id) AS item_count
     FROM collections c
     LEFT JOIN favorite_collections fc
       ON fc.client_id = c.client_id AND fc.collection_id = c.id
     WHERE c.client_id = ?
     GROUP BY c.id, c.name, c.created_at
     ORDER BY c.updated_at DESC, c.id DESC`,
    [clientId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    itemCount: Number(row.item_count),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
  }));
}

export async function createCollection(clientId: string, name: string): Promise<CreativeCollection> {
  if (!pool) {
    const collections = memoryCollections.get(clientId) ?? new Map<string, CreativeCollection>();
    const existing = [...collections.values()].find((collection) => collection.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (existing) return existing;
    const collection: CreativeCollection = {
      id: String(++memoryCollectionId),
      name,
      itemCount: 0,
      createdAt: new Date().toISOString(),
    };
    collections.set(collection.id, collection);
    memoryCollections.set(clientId, collections);
    return collection;
  }
  await pool.execute(
    `INSERT INTO collections (client_id, name)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP`,
    [clientId, name],
  );
  const collections = await getCollections(clientId);
  const collection = collections.find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (!collection) throw new Error("Созданная коллекция не найдена.");
  return collection;
}

export async function addFavorite(clientId: string, ad: AdCreative, collectionId?: string): Promise<boolean> {
  if (!pool) {
    if (collectionId && !memoryCollections.get(clientId)?.has(collectionId)) return false;
    const favorites = memoryFavorites.get(clientId) ?? new Set<string>();
    favorites.add(ad.id);
    memoryFavorites.set(clientId, favorites);
    const ads = memoryFavoriteAds.get(clientId) ?? new Map<string, AdCreative>();
    ads.set(ad.id, { ...ad, isFavorite: true });
    memoryFavoriteAds.set(clientId, ads);
    if (collectionId) {
      const memberships = memoryFavoriteCollections.get(clientId) ?? new Map<string, Set<string>>();
      const adCollections = memberships.get(ad.id) ?? new Set<string>();
      adCollections.add(collectionId);
      memberships.set(ad.id, adCollections);
      memoryFavoriteCollections.set(clientId, memberships);
      const collection = memoryCollections.get(clientId)?.get(collectionId);
      if (collection) collection.itemCount = [...memberships.values()].filter((ids) => ids.has(collectionId)).length;
    }
    return true;
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    if (collectionId) {
      const [collections] = await connection.execute<mysql.RowDataPacket[]>(
        "SELECT id FROM collections WHERE client_id = ? AND id = ? FOR UPDATE",
        [clientId, collectionId],
      );
      if (!collections.length) {
        await connection.rollback();
        return false;
      }
    }
    await writeCollectedAds(connection, [{ ad }]);
    await connection.execute(
      `INSERT INTO favorites (client_id, ad_id, source)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE source = VALUES(source)`,
      [clientId, ad.id, ad.source],
    );
    if (collectionId) {
      await connection.execute(
        `INSERT IGNORE INTO favorite_collections (client_id, ad_id, collection_id)
         VALUES (?, ?, ?)`,
        [clientId, ad.id, collectionId],
      );
    }
    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function removeFavorite(clientId: string, adId: string): Promise<void> {
  if (!pool) {
    memoryFavorites.get(clientId)?.delete(adId);
    memoryFavoriteAds.get(clientId)?.delete(adId);
    const memberships = memoryFavoriteCollections.get(clientId);
    const removedCollections = memberships?.get(adId);
    memberships?.delete(adId);
    for (const collectionId of removedCollections ?? []) {
      const collection = memoryCollections.get(clientId)?.get(collectionId);
      if (collection) collection.itemCount = [...(memberships?.values() ?? [])].filter((ids) => ids.has(collectionId)).length;
    }
    return;
  }
  await pool.execute("DELETE FROM favorites WHERE client_id = ? AND ad_id = ?", [clientId, adId]);
}

export async function closeDatabase(): Promise<void> {
  await pool?.end();
}
