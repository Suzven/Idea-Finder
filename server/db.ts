import mysql from "mysql2/promise";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { config } from "./config.js";
import type { AdCreative, AdSource, AIAnalysisReport, AIAnalysisReportSummary, AIAnalysisResponse, CreativeCollection, IntegrationLogDetail, IntegrationLogsResponse, IntegrationLogStatus, IntegrationLogSummary, ReviewProxySettings, ReviewProxySettingsInput } from "../src/shared/types.js";

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
const memoryCreativeNotes = new Map<string, Map<string, string>>();
const memoryAIReports = new Map<string, Map<string, AIAnalysisReport>>();
const memoryAILandingScreenshots = new Map<string, { reportId: string; buffer: Buffer; mimeType: string }>();
const memoryReviewProxySettings = new Map<string, StoredReviewProxySettings>();
let memoryCollectionId = 0;
let memoryAIReportId = 0;

export interface StoredReviewProxySettings {
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
  updatedAt?: string;
}

export interface StoredUser {
  id: string;
  username: string;
  passwordHash: string;
  displayName: string;
  role: "admin" | "user";
  isActive: boolean;
}

export interface StoredPrivateSettings {
  openaiApiKey?: string | null;
  googleAds?: {
    developerToken?: string | null;
    customerId?: string | null;
    loginCustomerId?: string | null;
    serviceAccountJson?: string | null;
  };
}

function proxyEncryptionKey(): Buffer {
  const secret = databaseConfig.password;
  if (!secret) throw new Error("DB_PASSWORD недоступен для шифрования пароля прокси.");
  return createHash("sha256").update(`spyservice:review-proxy:v1:${secret}`).digest();
}

function encryptProxyPassword(value?: string): string | null {
  if (!value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", proxyEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptProxyPassword(value: unknown): string | undefined {
  if (!value) return undefined;
  const encoded = String(value);
  if (!encoded.startsWith("v1.")) return encoded;
  const [, ivValue, tagValue, encryptedValue] = encoded.split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("Повреждён сохранённый пароль прокси.");
  const decipher = createDecipheriv("aes-256-gcm", proxyEncryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
}

function privateSettingsEncryptionKey(): Buffer {
  const secret = databaseConfig.password;
  if (!secret) throw new Error("DB_PASSWORD недоступен для шифрования пользовательских настроек.");
  return createHash("sha256").update(`spyservice:user-private-settings:v1:${secret}`).digest();
}

function encryptPrivateValue(value?: string | null): string | null {
  if (!value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", privateSettingsEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptPrivateValue(value: unknown): string | undefined {
  if (!value) return undefined;
  const encoded = String(value);
  if (!encoded.startsWith("v1.")) return encoded;
  const [, ivValue, tagValue, encryptedValue] = encoded.split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("Повреждены зашифрованные настройки пользователя.");
  const decipher = createDecipheriv("aes-256-gcm", privateSettingsEncryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
}

function mapStoredUser(row: mysql.RowDataPacket): StoredUser {
  return {
    id: String(row.id),
    username: String(row.username),
    passwordHash: String(row.password_hash),
    displayName: String(row.display_name),
    role: row.role === "admin" ? "admin" : "user",
    isActive: Boolean(row.is_active),
  };
}

export function userDataScope(userId: string): string {
  return `user:${userId}`;
}

export async function findUserByUsername(username: string): Promise<StoredUser | null> {
  if (!pool) return null;
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT id, username, password_hash, display_name, role, is_active
     FROM users WHERE username = ? LIMIT 1`,
    [username],
  );
  return rows[0] ? mapStoredUser(rows[0]) : null;
}

export async function findUserBySessionHash(tokenHash: string): Promise<StoredUser | null> {
  if (!pool) return null;
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT u.id, u.username, u.password_hash, u.display_name, u.role, u.is_active
     FROM user_sessions s
     INNER JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP AND u.is_active = 1
     LIMIT 1`,
    [tokenHash],
  );
  if (!rows[0]) return null;
  await pool.execute("UPDATE user_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = ?", [tokenHash]);
  return mapStoredUser(rows[0]);
}

export async function createUserSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
  if (!pool) throw new Error("База данных не подключена.");
  await pool.execute(
    "INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    [tokenHash, userId, expiresAt],
  );
  await pool.execute("DELETE FROM user_sessions WHERE expires_at <= CURRENT_TIMESTAMP");
}

export async function deleteUserSession(tokenHash: string): Promise<void> {
  if (!pool) return;
  await pool.execute("DELETE FROM user_sessions WHERE token_hash = ?", [tokenHash]);
}

export async function getPrivateSettingsCredentials(userId: string): Promise<StoredPrivateSettings> {
  if (!pool) return {};
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT openai_api_key, google_ads_developer_token, google_ads_customer_id,
            google_ads_login_customer_id, google_ads_service_account_json
     FROM user_private_settings WHERE user_id = ?`,
    [userId],
  );
  const row = rows[0];
  if (!row) return {};
  const developerToken = decryptPrivateValue(row.google_ads_developer_token);
  const serviceAccountJson = decryptPrivateValue(row.google_ads_service_account_json);
  const customerId = nullableString(row.google_ads_customer_id) ?? undefined;
  const loginCustomerId = nullableString(row.google_ads_login_customer_id) ?? undefined;
  return {
    openaiApiKey: decryptPrivateValue(row.openai_api_key),
    googleAds: developerToken || serviceAccountJson || customerId || loginCustomerId ? {
      developerToken,
      customerId,
      loginCustomerId,
      serviceAccountJson,
    } : undefined,
  };
}

export async function savePrivateSettings(userId: string, input: StoredPrivateSettings): Promise<void> {
  if (!pool) throw new Error("База данных не подключена.");
  const current = await getPrivateSettingsCredentials(userId);
  const googleAds = { ...(current.googleAds ?? {}), ...(input.googleAds ?? {}) };
  const openaiApiKey = input.openaiApiKey === undefined ? current.openaiApiKey : input.openaiApiKey;
  await pool.execute(
    `INSERT INTO user_private_settings
      (user_id, openai_api_key, google_ads_developer_token, google_ads_customer_id,
       google_ads_login_customer_id, google_ads_service_account_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       openai_api_key = VALUES(openai_api_key),
       google_ads_developer_token = VALUES(google_ads_developer_token),
       google_ads_customer_id = VALUES(google_ads_customer_id),
       google_ads_login_customer_id = VALUES(google_ads_login_customer_id),
       google_ads_service_account_json = VALUES(google_ads_service_account_json),
       updated_at = CURRENT_TIMESTAMP`,
    [
      userId,
      encryptPrivateValue(openaiApiKey),
      encryptPrivateValue(googleAds.developerToken),
      googleAds.customerId || null,
      googleAds.loginCustomerId || null,
      encryptPrivateValue(googleAds.serviceAccountJson),
    ],
  );
}

export async function claimLegacyClientData(legacyClientId: string, userId: string): Promise<void> {
  if (!pool || !/^[0-9a-f-]{20,100}$/i.test(legacyClientId)) return;
  const target = userDataScope(userId);
  if (legacyClientId === target) return;
  const connection = await pool.getConnection();
  try {
    const [sourceRows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM favorites WHERE client_id = ?) +
         (SELECT COUNT(*) FROM collections WHERE client_id = ?) +
         (SELECT COUNT(*) FROM ai_analysis_reports WHERE client_id = ?) +
         (SELECT COUNT(*) FROM review_proxy_settings WHERE client_id = ?) +
         (SELECT COUNT(*) FROM saved_searches WHERE client_id = ?) AS total`,
      [legacyClientId, legacyClientId, legacyClientId, legacyClientId, legacyClientId],
    );
    if (!Number(sourceRows[0]?.total ?? 0)) return;
    const [targetRows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM favorites WHERE client_id = ?) +
         (SELECT COUNT(*) FROM collections WHERE client_id = ?) AS total`,
      [target, target],
    );
    if (Number(targetRows[0]?.total ?? 0)) return;
    await connection.query("SET FOREIGN_KEY_CHECKS = 0");
    await connection.beginTransaction();
    for (const table of ["favorites", "collections", "favorite_collections", "creative_notes", "ai_analysis_reports", "review_proxy_settings", "saved_searches"]) {
      await connection.execute(`UPDATE ${table} SET client_id = ? WHERE client_id = ?`, [target, legacyClientId]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    await connection.query("SET FOREIGN_KEY_CHECKS = 1").catch(() => undefined);
    connection.release();
  }
}

export interface CollectedAdEntry {
  ad: AdCreative;
  sourcePayload?: unknown;
}

export interface StoredFavorite {
  ad: AdCreative;
  sourcePayload?: unknown;
  analysisNote?: string;
}

export interface AIAnalysisLandingAssetInput {
  adId: string;
  advertiser: string;
  headline?: string;
  cta?: string;
  landingUrl: string;
  screenshot?: Buffer;
  screenshotMime?: string;
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

function publicReviewProxySettings(value?: StoredReviewProxySettings): ReviewProxySettings {
  return {
    configured: Boolean(value?.server),
    server: value?.server ?? "",
    username: value?.username ?? "",
    bypass: value?.bypass ?? "",
    hasPassword: Boolean(value?.password),
    ...(value?.updatedAt ? { updatedAt: value.updatedAt } : {}),
  };
}

export async function getReviewProxyCredentials(clientId: string): Promise<StoredReviewProxySettings | undefined> {
  if (!pool) return memoryReviewProxySettings.get(clientId);
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT proxy_server, proxy_username, proxy_password, proxy_bypass, updated_at
     FROM review_proxy_settings WHERE client_id = ?`,
    [clientId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    server: String(row.proxy_server),
    username: nullableString(row.proxy_username) ?? undefined,
    password: decryptProxyPassword(row.proxy_password),
    bypass: nullableString(row.proxy_bypass) ?? undefined,
    updatedAt: toIsoString(row.updated_at),
  };
}

export async function getReviewProxySettings(clientId: string): Promise<ReviewProxySettings> {
  return publicReviewProxySettings(await getReviewProxyCredentials(clientId));
}

export async function saveReviewProxySettings(clientId: string, input: ReviewProxySettingsInput): Promise<ReviewProxySettings> {
  const server = input.server.trim();
  const username = input.username?.trim() || undefined;
  const bypass = input.bypass?.trim() || undefined;
  const passwordProvided = input.password !== undefined;
  if (!pool) {
    const current = memoryReviewProxySettings.get(clientId);
    const value: StoredReviewProxySettings = {
      server,
      username,
      password: passwordProvided ? input.password || undefined : current?.password,
      bypass,
      updatedAt: new Date().toISOString(),
    };
    memoryReviewProxySettings.set(clientId, value);
    return publicReviewProxySettings(value);
  }
  const encryptedPassword = passwordProvided ? encryptProxyPassword(input.password) : null;
  await pool.execute(
    `INSERT INTO review_proxy_settings
      (client_id, proxy_server, proxy_username, proxy_password, proxy_bypass)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       proxy_server = VALUES(proxy_server),
       proxy_username = VALUES(proxy_username),
       proxy_password = IF(?, VALUES(proxy_password), proxy_password),
       proxy_bypass = VALUES(proxy_bypass),
       updated_at = CURRENT_TIMESTAMP`,
    [clientId, server, username ?? null, encryptedPassword, bypass ?? null, passwordProvided ? 1 : 0],
  );
  return getReviewProxySettings(clientId);
}

export async function deleteReviewProxySettings(clientId: string): Promise<boolean> {
  if (!pool) return memoryReviewProxySettings.delete(clientId);
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    "DELETE FROM review_proxy_settings WHERE client_id = ?",
    [clientId],
  );
  return result.affectedRows > 0;
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
      .map((ad) => ({ ad: { ...ad, isFavorite: true }, analysisNote: memoryCreativeNotes.get(clientId)?.get(ad.id) }));
  }
  const collectionJoin = collectionId
    ? "INNER JOIN favorite_collections fc ON fc.client_id = f.client_id AND fc.ad_id = f.ad_id AND fc.collection_id = ?"
    : "";
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT c.normalized_payload, c.source_payload, n.note AS analysis_note
     FROM favorites f
     ${collectionJoin}
     INNER JOIN collected_ads c ON c.id = f.ad_id
     LEFT JOIN creative_notes n ON n.client_id = f.client_id AND n.ad_id = f.ad_id
     WHERE f.client_id = ?
     ORDER BY f.created_at DESC`,
    collectionId ? [collectionId, clientId] : [clientId],
  );
  return rows.flatMap((row) => {
    const ad = parseJson(row.normalized_payload) as AdCreative | undefined;
    if (!ad?.id || !ad.source) return [];
    return [{
      ad: { ...ad, isFavorite: true },
      sourcePayload: parseJson(row.source_payload),
      analysisNote: row.analysis_note === null || row.analysis_note === undefined ? undefined : String(row.analysis_note),
    }];
  });
}

export async function setCreativeAnalysisNotes(
  clientId: string,
  collectionId: string,
  adIds: string[],
  note: string,
): Promise<number> {
  const uniqueIds = [...new Set(adIds)];
  if (!pool) {
    const memberships = memoryFavoriteCollections.get(clientId);
    const notes = memoryCreativeNotes.get(clientId) ?? new Map<string, string>();
    let updated = 0;
    for (const adId of uniqueIds) {
      if (!memberships?.get(adId)?.has(collectionId)) continue;
      if (note) notes.set(adId, note);
      else notes.delete(adId);
      updated += 1;
    }
    memoryCreativeNotes.set(clientId, notes);
    return updated;
  }

  if (!uniqueIds.length) return 0;
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT ad_id FROM favorite_collections
     WHERE client_id = ? AND collection_id = ? AND ad_id IN (${placeholders})`,
    [clientId, collectionId, ...uniqueIds],
  );
  const allowedIds = rows.map((row) => String(row.ad_id));
  if (!allowedIds.length) return 0;
  if (!note) {
    const deletePlaceholders = allowedIds.map(() => "?").join(", ");
    await pool.execute<mysql.ResultSetHeader>(
      `DELETE FROM creative_notes WHERE client_id = ? AND ad_id IN (${deletePlaceholders})`,
      [clientId, ...allowedIds],
    );
    return allowedIds.length;
  }
  for (const adId of allowedIds) {
    await pool.execute(
      `INSERT INTO creative_notes (client_id, ad_id, note)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE note = VALUES(note), updated_at = CURRENT_TIMESTAMP`,
      [clientId, adId, note],
    );
  }
  return allowedIds.length;
}

function reportTimestamp(date: Date): string {
  return date.toISOString().replace("T", "_").replace(/:/g, "-").slice(0, 19);
}

function mapAIReportSummary(row: mysql.RowDataPacket): AIAnalysisReportSummary {
  return {
    id: String(row.id),
    name: String(row.report_name),
    collectionId: row.collection_id === null || row.collection_id === undefined ? undefined : String(row.collection_id),
    collectionName: String(row.collection_name),
    model: String(row.model),
    analyzedCount: Number(row.analyzed_count),
    totalCount: Number(row.total_count),
    opportunityScore: Number(row.opportunity_score),
    niche: String(row.niche),
    createdAt: toIsoString(row.created_at),
  };
}

export async function saveAIAnalysisReport(
  clientId: string,
  collection: CreativeCollection,
  result: AIAnalysisResponse,
  landingAssets: AIAnalysisLandingAssetInput[] = [],
): Promise<AIAnalysisReport> {
  const createdAt = new Date();
  const name = `${collection.name}_${reportTimestamp(createdAt)}`;
  const storedResult: AIAnalysisResponse = {
    ...result,
    landings: landingAssets.map(({ screenshot: _screenshot, screenshotMime: _mime, ...landing }) => landing),
  };
  if (!pool) {
    const id = String(++memoryAIReportId);
    const landings = landingAssets.map(({ screenshot, screenshotMime, ...landing }) => {
      if (!screenshot) return landing;
      const token = randomUUID();
      memoryAILandingScreenshots.set(token, { reportId: id, buffer: screenshot, mimeType: screenshotMime ?? "image/jpeg" });
      return { ...landing, screenshotUrl: `/api/ai-analysis/landing-screenshots/${token}` };
    });
    const report: AIAnalysisReport = {
      id,
      name,
      collectionId: collection.id,
      collectionName: collection.name,
      model: result.model,
      analyzedCount: result.analyzedCount,
      totalCount: result.totalCount,
      opportunityScore: result.analysis.opportunityScore,
      niche: result.analysis.niche,
      createdAt: createdAt.toISOString(),
      result: { ...storedResult, landings },
    };
    const reports = memoryAIReports.get(clientId) ?? new Map<string, AIAnalysisReport>();
    reports.set(id, report);
    memoryAIReports.set(clientId, reports);
    return report;
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [insert] = await connection.execute<mysql.ResultSetHeader>(
      `INSERT INTO ai_analysis_reports
        (client_id, collection_id, collection_name, report_name, model, analyzed_count, total_count, opportunity_score, niche, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clientId,
        collection.id,
        collection.name,
        name,
        result.model,
        result.analyzedCount,
        result.totalCount,
        result.analysis.opportunityScore,
        result.analysis.niche,
        JSON.stringify(storedResult),
      ],
    );
    const reportId = String(insert.insertId);
    const landings = [];
    for (const [position, asset] of landingAssets.entries()) {
      const token = randomUUID();
      await connection.execute(
        `INSERT INTO ai_analysis_report_landings
          (report_id, position, ad_id, advertiser, headline, cta, landing_url, screenshot, screenshot_mime, access_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reportId,
          position,
          asset.adId,
          asset.advertiser,
          asset.headline ?? null,
          asset.cta ?? null,
          asset.landingUrl,
          asset.screenshot ?? null,
          asset.screenshot ? (asset.screenshotMime ?? "image/jpeg") : null,
          token,
        ],
      );
      landings.push({
        adId: asset.adId,
        advertiser: asset.advertiser,
        headline: asset.headline,
        cta: asset.cta,
        landingUrl: asset.landingUrl,
        ...(asset.screenshot ? { screenshotUrl: `/api/ai-analysis/landing-screenshots/${token}` } : {}),
      });
    }
    await connection.commit();
    return {
      id: reportId,
      name,
      collectionId: collection.id,
      collectionName: collection.name,
      model: result.model,
      analyzedCount: result.analyzedCount,
      totalCount: result.totalCount,
      opportunityScore: result.analysis.opportunityScore,
      niche: result.analysis.niche,
      createdAt: createdAt.toISOString(),
      result: { ...storedResult, landings },
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function getAIAnalysisReports(clientId: string): Promise<AIAnalysisReportSummary[]> {
  if (!pool) {
    return [...(memoryAIReports.get(clientId)?.values() ?? [])]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ result: _result, ...summary }) => summary);
  }
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT id, collection_id, collection_name, report_name, model, analyzed_count, total_count,
            opportunity_score, niche, created_at
     FROM ai_analysis_reports WHERE client_id = ? ORDER BY created_at DESC, id DESC`,
    [clientId],
  );
  return rows.map(mapAIReportSummary);
}

export async function getAIAnalysisReport(clientId: string, reportId: string): Promise<AIAnalysisReport | null> {
  if (!pool) return memoryAIReports.get(clientId)?.get(reportId) ?? null;
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT id, collection_id, collection_name, report_name, model, analyzed_count, total_count,
            opportunity_score, niche, result_json, created_at
     FROM ai_analysis_reports WHERE client_id = ? AND id = ?`,
    [clientId, reportId],
  );
  const row = rows[0];
  if (!row) return null;
  const result = parseJson(row.result_json) as AIAnalysisResponse | undefined;
  if (!result?.analysis) return null;
  const [landingRows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT ad_id, advertiser, headline, cta, landing_url, access_token,
            screenshot IS NOT NULL AS has_screenshot
     FROM ai_analysis_report_landings
     WHERE report_id = ? ORDER BY position ASC, id ASC`,
    [reportId],
  );
  const landings = landingRows.map((landing) => ({
    adId: String(landing.ad_id),
    advertiser: String(landing.advertiser),
    headline: landing.headline === null ? undefined : String(landing.headline),
    cta: landing.cta === null ? undefined : String(landing.cta),
    landingUrl: String(landing.landing_url),
    ...(Boolean(landing.has_screenshot) ? { screenshotUrl: `/api/ai-analysis/landing-screenshots/${String(landing.access_token)}` } : {}),
  }));
  return { ...mapAIReportSummary(row), result: { ...result, landings } };
}

export async function getAIAnalysisLandingScreenshot(clientId: string, token: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (!pool) {
    const asset = memoryAILandingScreenshots.get(token);
    return asset && memoryAIReports.get(clientId)?.has(asset.reportId) ? { buffer: asset.buffer, mimeType: asset.mimeType } : null;
  }
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT l.screenshot, l.screenshot_mime
     FROM ai_analysis_report_landings l
     INNER JOIN ai_analysis_reports r ON r.id = l.report_id
     WHERE l.access_token = ? AND r.client_id = ? AND l.screenshot IS NOT NULL`,
    [token, clientId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    buffer: Buffer.isBuffer(row.screenshot) ? row.screenshot : Buffer.from(row.screenshot as Uint8Array),
    mimeType: String(row.screenshot_mime || "image/jpeg"),
  };
}

export async function deleteAIAnalysisReport(clientId: string, reportId: string): Promise<boolean> {
  if (!pool) {
    const deleted = memoryAIReports.get(clientId)?.delete(reportId) ?? false;
    if (deleted) {
      for (const [token, asset] of memoryAILandingScreenshots) {
        if (asset.reportId === reportId) memoryAILandingScreenshots.delete(token);
      }
    }
    return deleted;
  }
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    "DELETE FROM ai_analysis_reports WHERE client_id = ? AND id = ?",
    [clientId, reportId],
  );
  return result.affectedRows > 0;
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

export async function deleteCollection(clientId: string, collectionId: string): Promise<number | null> {
  if (!pool) {
    const collections = memoryCollections.get(clientId);
    if (!collections?.has(collectionId)) return null;
    const memberships = memoryFavoriteCollections.get(clientId);
    const adIds = [...(memberships?.entries() ?? [])]
      .filter(([, collectionIds]) => collectionIds.has(collectionId))
      .map(([adId]) => adId);
    for (const adId of adIds) {
      memoryFavorites.get(clientId)?.delete(adId);
      memoryFavoriteAds.get(clientId)?.delete(adId);
      memoryCreativeNotes.get(clientId)?.delete(adId);
      memberships?.delete(adId);
    }
    collections.delete(collectionId);
    return adIds.length;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [collections] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT id FROM collections WHERE client_id = ? AND id = ? FOR UPDATE",
      [clientId, collectionId],
    );
    if (!collections.length) {
      await connection.rollback();
      return null;
    }
    const [favorites] = await connection.execute<mysql.ResultSetHeader>(
      `DELETE f FROM favorites f
       INNER JOIN favorite_collections fc
         ON fc.client_id = f.client_id AND fc.ad_id = f.ad_id
       WHERE fc.client_id = ? AND fc.collection_id = ?`,
      [clientId, collectionId],
    );
    await connection.execute(
      "DELETE FROM collections WHERE client_id = ? AND id = ?",
      [clientId, collectionId],
    );
    await connection.commit();
    return favorites.affectedRows;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
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
    memoryCreativeNotes.get(clientId)?.delete(adId);
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
