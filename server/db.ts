import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;
const pool = config.databaseUrl ? new Pool({ connectionString: config.databaseUrl }) : null;
const memoryFavorites = new Map<string, Set<string>>();

export async function healthcheckDatabase(): Promise<"connected" | "disabled" | "unavailable"> {
  if (!pool) return "disabled";
  try {
    await pool.query("SELECT 1");
    return "connected";
  } catch {
    return "unavailable";
  }
}

export async function getFavoriteIds(clientId: string): Promise<Set<string>> {
  if (!pool) return new Set(memoryFavorites.get(clientId) ?? []);
  const result = await pool.query<{ ad_id: string }>(
    "SELECT ad_id FROM favorites WHERE client_id = $1",
    [clientId],
  );
  return new Set(result.rows.map((row) => row.ad_id));
}

export async function addFavorite(clientId: string, adId: string, source: string): Promise<void> {
  if (!pool) {
    const favorites = memoryFavorites.get(clientId) ?? new Set<string>();
    favorites.add(adId);
    memoryFavorites.set(clientId, favorites);
    return;
  }
  await pool.query(
    `INSERT INTO favorites (client_id, ad_id, source)
     VALUES ($1, $2, $3)
     ON CONFLICT (client_id, ad_id) DO NOTHING`,
    [clientId, adId, source],
  );
}

export async function removeFavorite(clientId: string, adId: string): Promise<void> {
  if (!pool) {
    memoryFavorites.get(clientId)?.delete(adId);
    return;
  }
  await pool.query("DELETE FROM favorites WHERE client_id = $1 AND ad_id = $2", [clientId, adId]);
}

export async function closeDatabase(): Promise<void> {
  await pool?.end();
}
