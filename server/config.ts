import "dotenv/config";

const port = Number(process.env.PORT ?? 4100);

export const config = {
  port,
  nodeEnv: process.env.NODE_ENV ?? "development",
  apiMode: (process.env.API_MODE ?? "auto") as "auto" | "demo" | "live",
  database: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    name: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  },
  metaAccessToken: process.env.META_ACCESS_TOKEN,
  metaGraphVersion: process.env.META_GRAPH_VERSION ?? "v26.0",
  metaChromiumExecutablePath: process.env.META_CHROMIUM_EXECUTABLE_PATH,
  tiktokAccessToken: process.env.TIKTOK_ACCESS_TOKEN,
  trustProxy: process.env.TRUST_PROXY === "true",
};
