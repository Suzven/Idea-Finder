import "dotenv/config";

const port = Number(process.env.PORT ?? 4100);

export const config = {
  port,
  nodeEnv: process.env.NODE_ENV ?? "development",
  apiMode: (process.env.API_MODE ?? "auto") as "auto" | "demo" | "live",
  databaseUrl: process.env.DATABASE_URL,
  metaAccessToken: process.env.META_ACCESS_TOKEN,
  metaGraphVersion: process.env.META_GRAPH_VERSION ?? "v26.0",
  tiktokAccessToken: process.env.TIKTOK_ACCESS_TOKEN,
  trustProxy: process.env.TRUST_PROXY === "true",
};
