import mysql from "mysql2/promise";
import { config } from "./config.js";

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

export async function healthcheckDatabase(): Promise<"connected" | "disabled" | "unavailable"> {
  if (!pool) return "disabled";
  try {
    await pool.execute("SELECT 1");
    return "connected";
  } catch {
    return "unavailable";
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

export async function addFavorite(clientId: string, adId: string, source: string): Promise<void> {
  if (!pool) {
    const favorites = memoryFavorites.get(clientId) ?? new Set<string>();
    favorites.add(adId);
    memoryFavorites.set(clientId, favorites);
    return;
  }
  await pool.execute(
    `INSERT IGNORE INTO favorites (client_id, ad_id, source)
     VALUES (?, ?, ?)`,
    [clientId, adId, source],
  );
}

export async function removeFavorite(clientId: string, adId: string): Promise<void> {
  if (!pool) {
    memoryFavorites.get(clientId)?.delete(adId);
    return;
  }
  await pool.execute("DELETE FROM favorites WHERE client_id = ? AND ad_id = ?", [clientId, adId]);
}

export async function closeDatabase(): Promise<void> {
  await pool?.end();
}
