import mysql from "mysql2/promise";
import { config } from "./config.js";

const databaseConfigured = Boolean(
  config.database.host && config.database.name && config.database.user && config.database.password,
);

const pool = databaseConfigured
  ? mysql.createPool({
      host: config.database.host,
      port: config.database.port,
      database: config.database.name,
      user: config.database.user,
      password: config.database.password,
      charset: "utf8mb4",
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    })
  : null;
const memoryFavorites = new Map<string, Set<string>>();

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
