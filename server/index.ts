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
import { addFavorite, claimLegacyClientData, clearIntegrationLogs, closeDatabase, createCollection, deleteAIAnalysisReport, deleteCollection, deleteExpiredIntegrationLogs, deleteReviewProxySettings, findUserByUsername, getAIAnalysisLandingScreenshot, getAIAnalysisReport, getAIAnalysisReports, getCollections, getFavoriteAds, getFavoriteIds, getIntegrationLogById, getIntegrationLogs, getPrivateSettingsCredentials, getReviewProxyCredentials, getReviewProxySettings, healthcheckDatabase, removeFavorite, saveAIAnalysisReport, savePrivateSettings, saveReviewProxySettings, setCreativeAnalysisNotes, userDataScope } from "./db.js";
import { assertLoginAllowed, clearFailedLogins, endSession, getAuthenticatedUser, loginThrottleKey, optionalAuthentication, recordFailedLogin, requireAuthentication, startSession, verifyPassword } from "./auth.js";
import { AppError } from "./errors.js";
import { filterAds } from "./services/filterAds.js";
import { collectKeywordVolume } from "./services/keywordVolume.js";
import { collectGoogleTrends } from "./services/googleTrends.js";
import { fetchThreadsConversation, fetchThreadsPostViewCounts, initializeThreadsSession, searchThreadsPosts } from "./services/threadsOverview.js";
import type { ThreadsBrowserSession } from "./services/threadsOverview.js";
import { fetchRedditConversation, searchRedditPosts } from "./services/redditOverview.js";
import { adoptLegacyKeywordSurferExtension, deleteKeywordSurferExtension, getKeywordSurferExtensionInfo, installKeywordSurferExtension } from "./services/keywordSurfer.js";
import { getMetaMedia, registerMetaAd, streamMetaMedia } from "./services/metaSnapshot.js";
import { analyzeCollection } from "./services/aiAnalysis.js";
import { cancelReviewChallenge, captureReviewChallengeFrame, clickReviewChallenge, scrollReviewChallenge } from "./services/reviewChallenge.js";
import { searchCompanyReviews, testReviewProxyConnection } from "./services/reviewAnalysis.js";
import type { AdFilters, AdSource, AdsResponse, AIAnalysisJobError, AIAnalysisJobResponse, AIAnalysisResponse, GoogleTrendsJobResponse, GoogleTrendsProgress, GoogleTrendsReport, GoogleTrendsRequest, PrivateSettingsSummary, RedditLogEntry, RedditPost, RedditSearchJobResponse, RedditSearchRequest, RedditSearchResponse, ReviewProxyTestJobResponse, ReviewProxyTestResult, ReviewSearchJobResponse, ReviewSearchResponse, ReviewSource, ReviewSourceProgress, ThreadsPost } from "../src/shared/types.js";

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
  progress: ReviewSourceProgress[];
  result?: ReviewSearchResponse;
  error?: AIAnalysisJobError;
}

const reviewSearchJobs = new Map<string, StoredReviewSearchJob>();
interface StoredReviewProxyTestJob {
  jobId: string;
  clientId: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  result?: ReviewProxyTestResult;
  error?: AIAnalysisJobError;
}

const reviewProxyTestJobs = new Map<string, StoredReviewProxyTestJob>();
interface StoredGoogleTrendsJob {
  jobId: string;
  clientId: string;
  request: GoogleTrendsRequest;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  progress?: GoogleTrendsProgress;
  result?: GoogleTrendsReport;
  error?: AIAnalysisJobError;
}

const googleTrendsJobs = new Map<string, StoredGoogleTrendsJob>();
interface StoredRedditSearchJob {
  jobId: string;
  clientId: string;
  request: RedditSearchRequest;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  logs: RedditLogEntry[];
  result?: RedditSearchResponse;
  error?: AIAnalysisJobError;
}

const redditSearchJobs = new Map<string, StoredRedditSearchJob>();
const AI_JOB_TTL_MS = 30 * 60_000;
const MAX_ACTIVE_AI_JOBS = 2;
const MAX_ACTIVE_REVIEW_JOBS = 2;
const MAX_ACTIVE_PROXY_TEST_JOBS = 2;
const MAX_ACTIVE_GOOGLE_TRENDS_JOBS = 2;
const MAX_ACTIVE_REDDIT_SEARCH_JOBS = 2;
const REVIEW_SOURCE_LABELS: Record<ReviewSource, string> = {
  trustpilot: "Trustpilot",
  capterra: "Capterra",
  softwareadvice: "Software Advice",
  producthunt: "Product Hunt",
};

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
    progress: job.progress,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function publicReviewProxyTestJob(job: StoredReviewProxyTestJob): ReviewProxyTestJobResponse {
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
  return userDataScope(getAuthenticatedUser(request).id);
}

function publicGoogleTrendsJob(job: StoredGoogleTrendsJob): GoogleTrendsJobResponse {
  return {
    jobId: job.jobId,
    status: job.status,
    ...(job.progress ? { progress: job.progress } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function publicRedditSearchJob(job: StoredRedditSearchJob): RedditSearchJobResponse {
  return {
    jobId: job.jobId,
    status: job.status,
    logs: job.logs,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function redditBackgroundJobError(error: unknown, traceId: string): AIAnalysisJobError {
  if (error instanceof AppError) return backgroundJobError(error, traceId);
  return {
    message: error instanceof Error ? error.message : "Неизвестная ошибка поиска Reddit.",
    code: "REDDIT_SEARCH_FAILED",
    httpStatus: 502,
    traceId,
  };
}

function shouldUseLive(source: AdSource): boolean {
  if (config.apiMode === "demo") return false;
  if (config.apiMode === "live") return true;
  return source === "meta" ? Boolean(config.metaAccessToken) : Boolean(config.tiktokAccessToken);
}

app.get("/api/health", async (_request, response) => {
  response.json({ status: "ok", apiMode: config.apiMode, database: await healthcheckDatabase() });
});

const loginSchema = z.object({
  username: z.string().trim().min(3).max(64),
  password: z.string().min(8).max(200),
  legacy: z.object({
    clientId: z.string().max(100).optional(),
    openaiApiKey: z.string().max(500).optional(),
    googleAds: z.object({
      developerToken: z.string().max(200),
      customerId: z.string().max(20),
      loginCustomerId: z.string().max(20).optional(),
      serviceAccountJson: z.string().max(20_000),
    }).optional(),
  }).optional(),
});

app.post("/api/auth/login", async (request, response, next) => {
  try {
    const parsed = loginSchema.parse(request.body);
    const throttleKey = loginThrottleKey(request, parsed.username);
    assertLoginAllowed(throttleKey);
    const user = await findUserByUsername(parsed.username);
    if (!user || !user.isActive || !await verifyPassword(parsed.password, user.passwordHash)) {
      recordFailedLogin(throttleKey);
      throw new AppError(401, "LOGIN_INVALID", "Неверный логин или пароль.");
    }
    clearFailedLogins(throttleKey);
    if (parsed.legacy?.clientId) await claimLegacyClientData(parsed.legacy.clientId, user.id);
    const importedOpenAI = parsed.legacy?.openaiApiKey?.trim();
    const importedGoogle = parsed.legacy?.googleAds;
    if (importedOpenAI || importedGoogle?.developerToken || importedGoogle?.serviceAccountJson) {
      await savePrivateSettings(user.id, {
        ...(importedOpenAI ? { openaiApiKey: importedOpenAI } : {}),
        ...(importedGoogle ? { googleAds: {
          developerToken: importedGoogle.developerToken.trim(),
          customerId: importedGoogle.customerId.replace(/\D/g, ""),
          loginCustomerId: importedGoogle.loginCustomerId?.replace(/\D/g, "") || null,
          serviceAccountJson: importedGoogle.serviceAccountJson.trim(),
        } } : {}),
      });
    }
    if (user.role === "admin") {
      await adoptLegacyKeywordSurferExtension(userDataScope(user.id)).catch((error) => {
        console.error("Не удалось перенести старую установку Keyword Surfer в профиль admin:", error);
      });
    }
    response.json({ user: await startSession(request, response, user) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/me", async (request, response, next) => {
  try {
    const user = await optionalAuthentication(request);
    if (!user) throw new AppError(401, "AUTH_REQUIRED", "Войдите в аккаунт.");
    response.json({ user });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", async (request, response, next) => {
  try {
    await endSession(request, response);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use("/api", requireAuthentication);

const privateSettingsSchema = z.object({
  openaiApiKey: z.string().trim().max(500).nullable().optional(),
  googleAds: z.object({
    developerToken: z.string().trim().max(200).nullable().optional(),
    customerId: z.string().trim().max(20).nullable().optional(),
    loginCustomerId: z.string().trim().max(20).nullable().optional(),
    serviceAccountJson: z.string().trim().max(20_000).nullable().optional(),
  }).optional(),
  threads: z.object({
    username: z.string().trim().max(255).nullable().optional(),
    password: z.string().max(500).nullable().optional(),
  }).optional(),
});

function privateSettingsSummary(settings: Awaited<ReturnType<typeof getPrivateSettingsCredentials>>): PrivateSettingsSummary {
  let serviceAccountEmail: string | undefined;
  try {
    const account = JSON.parse(settings.googleAds?.serviceAccountJson ?? "{}") as { client_email?: unknown };
    if (typeof account.client_email === "string") serviceAccountEmail = account.client_email;
  } catch { /* invalid JSON is rejected while saving */ }
  return {
    openai: { configured: Boolean(settings.openaiApiKey) },
    googleAds: {
      configured: Boolean(settings.googleAds?.developerToken && settings.googleAds.customerId && settings.googleAds.serviceAccountJson),
      customerId: settings.googleAds?.customerId ?? "",
      loginCustomerId: settings.googleAds?.loginCustomerId ?? "",
      hasDeveloperToken: Boolean(settings.googleAds?.developerToken),
      hasServiceAccount: Boolean(settings.googleAds?.serviceAccountJson),
      ...(serviceAccountEmail ? { serviceAccountEmail } : {}),
    },
    threads: {
      configured: Boolean(settings.threads?.username && settings.threads.password),
      username: settings.threads?.username ?? "",
      hasPassword: Boolean(settings.threads?.password),
      sessionSaved: Boolean(settings.threads?.storageState),
    },
  };
}

app.get("/api/settings/private", async (request, response, next) => {
  try {
    response.json(privateSettingsSummary(await getPrivateSettingsCredentials(getAuthenticatedUser(request).id)));
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings/private", async (request, response, next) => {
  try {
    const parsed = privateSettingsSchema.parse(request.body);
    if (parsed.googleAds?.serviceAccountJson) {
      try {
        const account = JSON.parse(parsed.googleAds.serviceAccountJson) as Record<string, unknown>;
        if (!account.client_email || !account.private_key) throw new Error("missing credentials");
      } catch {
        throw new AppError(400, "GOOGLE_SERVICE_ACCOUNT_INVALID", "JSON Google должен содержать client_email и private_key.");
      }
    }
    const userId = getAuthenticatedUser(request).id;
    await savePrivateSettings(userId, {
      ...(parsed.openaiApiKey !== undefined ? { openaiApiKey: parsed.openaiApiKey } : {}),
      ...(parsed.googleAds ? { googleAds: {
        ...(parsed.googleAds.developerToken !== undefined ? { developerToken: parsed.googleAds.developerToken } : {}),
        ...(parsed.googleAds.customerId !== undefined ? { customerId: parsed.googleAds.customerId?.replace(/\D/g, "") ?? null } : {}),
        ...(parsed.googleAds.loginCustomerId !== undefined ? { loginCustomerId: parsed.googleAds.loginCustomerId?.replace(/\D/g, "") ?? null } : {}),
        ...(parsed.googleAds.serviceAccountJson !== undefined ? { serviceAccountJson: parsed.googleAds.serviceAccountJson } : {}),
      } } : {}),
      ...(parsed.threads ? { threads: {
        ...(parsed.threads.username !== undefined ? { username: parsed.threads.username } : {}),
        ...(parsed.threads.password !== undefined ? { password: parsed.threads.password } : {}),
      } } : {}),
    });
    response.json(privateSettingsSummary(await getPrivateSettingsCredentials(userId)));
  } catch (error) {
    next(error);
  }
});

const threadsSearchSchema = z.object({
  query: z.string().trim().min(1).max(100),
  searchType: z.enum(["TOP", "RECENT"]).default("TOP"),
  searchMode: z.enum(["KEYWORD", "TAG"]).default("KEYWORD"),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  maxPages: z.coerce.number().int().min(1).max(50).default(10),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  after: z.string().trim().max(2_000).optional(),
});

const threadsPostSchema = z.object({
  id: z.string().trim().min(1).max(200),
  username: z.string().trim().max(200).default("threads_user"),
  text: z.string().max(20_000).default(""),
  timestamp: z.string().max(100).default(""),
  permalink: z.string().url().max(2_000),
  mediaType: z.string().max(50).optional(),
  mediaUrl: z.string().url().max(4_000).optional(),
  thumbnailUrl: z.string().url().max(4_000).optional(),
  isVerified: z.boolean().optional(),
  hasReplies: z.boolean().optional(),
  topicTag: z.string().max(500).optional(),
  linkAttachmentUrl: z.string().url().max(4_000).optional(),
  viewCount: z.number().int().nonnegative().optional(),
});

const threadsConversationSchema = z.object({
  post: threadsPostSchema,
  maxReplies: z.coerce.number().int().min(1).max(150).default(100),
});

const threadsViewCountsSchema = z.object({
  posts: z.array(threadsPostSchema).min(1).max(8),
});

const redditSearchSchema = z.object({
  query: z.string().trim().min(1).max(512),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  sort: z.enum(["relevance", "new", "top", "comments"]).default("new"),
});

const redditPostSchema = z.object({
  id: z.string().trim().min(1).max(20),
  title: z.string().max(1_000),
  text: z.string().max(50_000).default(""),
  author: z.string().max(200),
  subreddit: z.string().max(200),
  timestamp: z.string().max(100).default(""),
  permalink: z.string().url().max(2_000),
  destinationUrl: z.string().url().max(4_000).optional(),
  thumbnailUrl: z.string().url().max(4_000).optional(),
  score: z.number().int().default(0),
  commentCount: z.number().int().nonnegative().default(0),
  isNsfw: z.boolean().optional(),
});

const redditConversationSchema = z.object({
  post: redditPostSchema,
  maxDepth: z.coerce.number().int().min(1).max(50).default(4),
});

async function threadsBrowserSession(userId: string): Promise<ThreadsBrowserSession | undefined> {
  const stored = await getPrivateSettingsCredentials(userId);
  const username = stored.threads?.username?.trim();
  const password = stored.threads?.password;
  if (!username || !password) return undefined;
  return {
    username,
    password,
    ...(stored.threads?.storageState ? { storageState: stored.threads.storageState } : {}),
    saveStorageState: async (storageState) => {
      if (storageState !== stored.threads?.storageState) {
        await savePrivateSettings(userId, { threads: { storageState } });
      }
    },
  };
}

app.post("/api/threads/session", async (request, response, next) => {
  try {
    const userId = getAuthenticatedUser(request).id;
    const session = await threadsBrowserSession(userId);
    if (!session) {
      throw new AppError(400, "THREADS_CREDENTIALS_MISSING", "Сначала сохраните логин и пароль Threads в настройках.");
    }
    response.json(await initializeThreadsSession(session));
  } catch (error) {
    next(error);
  }
});

app.post("/api/threads/search", async (request, response, next) => {
  try {
    const parsed = threadsSearchSchema.parse(request.body);
    const user = getAuthenticatedUser(request);
    const session = await threadsBrowserSession(user.id);
    response.json(await searchThreadsPosts(parsed, session));
  } catch (error) {
    next(error);
  }
});

app.post("/api/threads/conversation", async (request, response, next) => {
  try {
    const parsed = threadsConversationSchema.parse(request.body);
    const post = parsed.post as ThreadsPost;
    const session = await threadsBrowserSession(getAuthenticatedUser(request).id);
    response.json(await fetchThreadsConversation(post, session, parsed.maxReplies));
  } catch (error) {
    next(error);
  }
});

app.post("/api/threads/views", async (request, response, next) => {
  try {
    const parsed = threadsViewCountsSchema.parse(request.body);
    const session = await threadsBrowserSession(getAuthenticatedUser(request).id);
    response.json(await fetchThreadsPostViewCounts(parsed.posts as ThreadsPost[], session));
  } catch (error) {
    next(error);
  }
});

app.post("/api/reddit/search", (request, response, next) => {
  try {
    const clientId = getClientId(request);
    const parsed = redditSearchSchema.parse(request.body);
    const redditRequest: RedditSearchRequest = {
      query: parsed.query,
      limit: parsed.limit,
      sort: "new",
    };
    const existing = [...redditSearchJobs.values()].find((job) =>
      job.clientId === clientId
      && job.request.query === redditRequest.query
      && job.request.limit === redditRequest.limit
      && (job.status === "queued" || job.status === "running"));
    if (existing) {
      response.status(202).json(publicRedditSearchJob(existing));
      return;
    }
    const userHasActiveJob = [...redditSearchJobs.values()].some((job) =>
      job.clientId === clientId && (job.status === "queued" || job.status === "running"));
    if (userHasActiveJob) {
      throw new AppError(409, "REDDIT_SEARCH_BUSY", "Предыдущий поиск Reddit ещё выполняется.", "Дождитесь завершения текущего поиска и повторите запрос.");
    }
    const activeCount = [...redditSearchJobs.values()].filter((job) => job.status === "queued" || job.status === "running").length;
    if (activeCount >= MAX_ACTIVE_REDDIT_SEARCH_JOBS) {
      throw new AppError(429, "REDDIT_SEARCH_SERVER_BUSY", "Сервер уже выполняет несколько поисков Reddit.", "Повторите запрос немного позже.");
    }
    const now = Date.now();
    const job: StoredRedditSearchJob = {
      jobId: randomUUID(),
      clientId,
      request: redditRequest,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      logs: [{
        at: new Date(now).toISOString(),
        stage: "queued",
        status: "info",
        message: "Поиск Reddit поставлен в фоновую очередь.",
        elapsedMs: 0,
      }],
    };
    redditSearchJobs.set(job.jobId, job);
    response.status(202).json(publicRedditSearchJob(job));

    void (async () => {
      job.status = "running";
      job.updatedAt = Date.now();
      try {
        const proxySettings = await getReviewProxyCredentials(clientId);
        job.result = await searchRedditPosts(redditRequest, (logs) => {
          job.logs = logs;
          job.updatedAt = Date.now();
        }, proxySettings);
        job.logs = job.result.logs;
        job.status = "completed";
      } catch (error) {
        job.status = "failed";
        job.error = redditBackgroundJobError(error, job.jobId);
        const errorLogs = error instanceof AppError && Array.isArray(error.details?.logs)
          ? error.details.logs as RedditLogEntry[]
          : [];
        if (errorLogs.length) job.logs = errorLogs;
        console.error(`[${job.jobId}] Reddit search background job failed`, error);
      } finally {
        job.updatedAt = Date.now();
      }
    })();
  } catch (error) {
    next(error);
  }
});

app.get("/api/reddit/search/jobs/:jobId", (request, response, next) => {
  try {
    const jobId = z.string().uuid().parse(request.params.jobId);
    const job = redditSearchJobs.get(jobId);
    if (!job || job.clientId !== getClientId(request)) {
      throw new AppError(404, "REDDIT_SEARCH_JOB_NOT_FOUND", "Задача поиска Reddit не найдена или уже удалена.");
    }
    response.json(publicRedditSearchJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/reddit/conversation", async (request, response, next) => {
  try {
    const clientId = getClientId(request);
    const parsed = redditConversationSchema.parse(request.body);
    const proxySettings = await getReviewProxyCredentials(clientId);
    response.json(await fetchRedditConversation(parsed.post as RedditPost, parsed.maxDepth, proxySettings));
  } catch (error) {
    next(error);
  }
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
  sources: z.array(z.enum(["trustpilot", "capterra", "softwareadvice", "producthunt"])).min(1).max(10),
});
const keywordVolumeSchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(120).refine((value) => !/[;\u0000-\u001f]/.test(value), "Ключ содержит недопустимый символ.")).min(1).max(30),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20),
  sources: z.array(z.enum(["google_ads", "keyword_surfer"])).min(1).max(2),
  credentials: z.object({
    googleAds: z.object({
      developerToken: z.string().trim().min(1).max(200),
      customerId: z.string().regex(/^\d{10}$/),
      loginCustomerId: z.string().regex(/^\d{10}$/).optional(),
      serviceAccountJson: z.string().min(10).max(20_000),
    }).optional(),
  }).optional(),
  surferRows: z.array(z.object({
    country: z.string().regex(/^[A-Z]{2}$/),
    keyword: z.string().trim().min(1).max(120),
    volume: z.number().finite().nonnegative(),
    cpc: z.number().finite().nonnegative().optional(),
  })).max(600).optional(),
});
const googleTrendsSchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(120).refine((value) => !/[;\u0000-\u001f]/.test(value), "Ключ содержит недопустимый символ.")).min(1).max(8),
  country: z.string().regex(/^(?:ALL|[A-Z]{2})$/).default("ALL"),
  timeRange: z.enum(["now 7-d", "today 1-m", "today 3-m", "today 12-m", "today 5-y", "all"]).default("today 5-y"),
  property: z.enum(["", "images", "news", "youtube", "froogle"]).default(""),
});
const reviewChallengeClickSchema = z.object({
  x: z.number().finite().min(0).max(2_500),
  y: z.number().finite().min(0).max(2_500),
});
const reviewChallengeScrollSchema = z.object({ deltaY: z.number().finite().min(-1_500).max(1_500) });
const reviewProxySettingsSchema = z.object({
  server: z.string().trim().min(1).max(500).refine((value) => {
    try {
      const parsed = new URL(value);
      return ["http:", "https:", "socks5:"].includes(parsed.protocol)
        && Boolean(parsed.hostname)
        && !parsed.username
        && !parsed.password;
    } catch {
      return false;
    }
  }, "Укажите прокси в формате http://host:port, https://host:port или socks5://host:port без логина в URL."),
  username: z.string().trim().max(255).optional(),
  password: z.string().max(1_000).optional(),
  bypass: z.string().trim().max(500).optional(),
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
    const user = getAuthenticatedUser(request);
    const storedSettings = await getPrivateSettingsCredentials(user.id);
    const apiKey = String(request.header("x-openai-api-key") ?? storedSettings.openaiApiKey ?? "").trim();
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
    const screenshot = await getAIAnalysisLandingScreenshot(getClientId(request), token);
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

app.get("/api/settings/review-proxy", async (request, response, next) => {
  try {
    response.json(await getReviewProxySettings(getClientId(request)));
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings/review-proxy", async (request, response, next) => {
  try {
    const settings = reviewProxySettingsSchema.parse(request.body);
    response.json(await saveReviewProxySettings(getClientId(request), {
      server: settings.server,
      ...(settings.username ? { username: settings.username } : {}),
      ...(settings.password ? { password: settings.password } : {}),
      ...(settings.bypass ? { bypass: settings.bypass } : {}),
    }));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/settings/review-proxy", async (request, response, next) => {
  try {
    await deleteReviewProxySettings(getClientId(request));
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/settings/review-proxy/test", (request, response, next) => {
  try {
    const clientId = getClientId(request);
    const existing = [...reviewProxyTestJobs.values()].find((job) =>
      job.clientId === clientId && (job.status === "queued" || job.status === "running"));
    if (existing) {
      response.status(202).json(publicReviewProxyTestJob(existing));
      return;
    }
    const activeCount = [...reviewProxyTestJobs.values()].filter((job) => job.status === "queued" || job.status === "running").length;
    if (activeCount >= MAX_ACTIVE_PROXY_TEST_JOBS) {
      throw new AppError(429, "REVIEW_PROXY_TEST_BUSY", "Сервер уже выполняет несколько проверок прокси.", "Дождитесь их завершения и повторите запрос.");
    }
    const now = Date.now();
    const job: StoredReviewProxyTestJob = {
      jobId: randomUUID(),
      clientId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    reviewProxyTestJobs.set(job.jobId, job);
    response.status(202).json(publicReviewProxyTestJob(job));

    void (async () => {
      job.status = "running";
      job.updatedAt = Date.now();
      try {
        const proxySettings = await getReviewProxyCredentials(clientId);
        job.result = await testReviewProxyConnection(proxySettings);
        job.status = "completed";
      } catch (error) {
        job.status = "failed";
        job.error = backgroundJobError(error, job.jobId);
        console.error(`[${job.jobId}] review proxy test background job failed`, error);
      } finally {
        job.updatedAt = Date.now();
      }
    })();
  } catch (error) {
    next(error);
  }
});

app.get("/api/settings/review-proxy/test/:jobId", (request, response, next) => {
  try {
    const jobId = z.string().uuid().parse(request.params.jobId);
    const job = reviewProxyTestJobs.get(jobId);
    if (!job || job.clientId !== getClientId(request)) {
      throw new AppError(404, "REVIEW_PROXY_TEST_JOB_NOT_FOUND", "Задача проверки прокси не найдена или уже удалена.");
    }
    response.json(publicReviewProxyTestJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/keyword-volume", async (request, response, next) => {
  try {
    const parsed = keywordVolumeSchema.parse(request.body);
    const user = getAuthenticatedUser(request);
    const storedSettings = await getPrivateSettingsCredentials(user.id);
    const storedGoogle = storedSettings.googleAds;
    const storedCredentials = storedGoogle?.developerToken && storedGoogle.customerId && storedGoogle.serviceAccountJson
      ? { googleAds: {
          developerToken: storedGoogle.developerToken,
          customerId: storedGoogle.customerId,
          ...(storedGoogle.loginCustomerId ? { loginCustomerId: storedGoogle.loginCustomerId } : {}),
          serviceAccountJson: storedGoogle.serviceAccountJson,
        } }
      : undefined;
    response.json(await collectKeywordVolume({
      keywords: [...new Set(parsed.keywords.map((keyword) => keyword.trim()))],
      countries: [...new Set(parsed.countries)],
      sources: [...new Set(parsed.sources)],
      ...(parsed.credentials ? { credentials: parsed.credentials } : storedCredentials ? { credentials: storedCredentials } : {}),
      ...(parsed.surferRows ? { surferRows: parsed.surferRows } : {}),
    }, userDataScope(user.id)));
  } catch (error) {
    next(error);
  }
});

app.post("/api/google-trends", (request, response, next) => {
  try {
    const parsed = googleTrendsSchema.parse(request.body);
    const keywords = [...new Map(parsed.keywords.map((keyword) => [keyword.toLocaleLowerCase("ru"), keyword.trim()])).values()];
    const clientId = getClientId(request);
    const existing = [...googleTrendsJobs.values()].find((job) =>
      job.clientId === clientId && (job.status === "queued" || job.status === "running"));
    if (existing) {
      response.status(202).json(publicGoogleTrendsJob(existing));
      return;
    }
    const activeCount = [...googleTrendsJobs.values()].filter((job) => job.status === "queued" || job.status === "running").length;
    if (activeCount >= MAX_ACTIVE_GOOGLE_TRENDS_JOBS) {
      throw new AppError(429, "GOOGLE_TRENDS_BUSY", "Сервер уже собирает несколько отчётов Google Trends.", "Дождитесь завершения текущих задач и повторите запрос.");
    }
    const trendsRequest: GoogleTrendsRequest = {
      keywords,
      country: parsed.country,
      timeRange: parsed.timeRange,
      property: parsed.property,
    };
    const now = Date.now();
    const job: StoredGoogleTrendsJob = {
      jobId: randomUUID(),
      clientId,
      request: trendsRequest,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      progress: {
        stage: "queued",
        activity: "Отчёт поставлен в очередь.",
        completedSteps: 0,
        totalSteps: 3 + keywords.length,
        logs: [],
      },
    };
    googleTrendsJobs.set(job.jobId, job);
    response.status(202).json(publicGoogleTrendsJob(job));

    void (async () => {
      job.status = "running";
      job.updatedAt = Date.now();
      try {
        job.result = await collectGoogleTrends(trendsRequest, (progress) => {
          job.progress = progress;
          job.updatedAt = Date.now();
        });
        job.progress = {
          stage: "complete",
          activity: "Отчёт Google Trends готов.",
          completedSteps: job.progress?.totalSteps ?? 1,
          totalSteps: job.progress?.totalSteps ?? 1,
          logs: job.result.logs,
        };
        job.status = "completed";
      } catch (error) {
        job.status = "failed";
        job.error = backgroundJobError(error, job.jobId);
        console.error(`[${job.jobId}] Google Trends background job failed`, error);
      } finally {
        job.updatedAt = Date.now();
      }
    })();
  } catch (error) {
    next(error);
  }
});

app.get("/api/google-trends/jobs/:jobId", (request, response, next) => {
  try {
    const jobId = z.string().uuid().parse(request.params.jobId);
    const job = googleTrendsJobs.get(jobId);
    if (!job || job.clientId !== getClientId(request)) {
      throw new AppError(404, "GOOGLE_TRENDS_JOB_NOT_FOUND", "Задача Google Trends не найдена или уже удалена.");
    }
    response.json(publicGoogleTrendsJob(job));
  } catch (error) {
    next(error);
  }
});

app.get("/api/settings/keyword-surfer-extension", async (request, response, next) => {
  try {
    response.json(await getKeywordSurferExtensionInfo(getClientId(request)));
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/settings/keyword-surfer-extension",
  express.raw({ type: ["application/zip", "application/octet-stream"], limit: "80mb" }),
  async (request, response, next) => {
    try {
      if (!Buffer.isBuffer(request.body)) throw new AppError(400, "KEYWORD_SURFER_ZIP_REQUIRED", "Выберите ZIP расширения Keyword Surfer.");
      console.info(`[keyword-surfer-upload] Получен архив ${request.body.length} байт.`);
      const info = await installKeywordSurferExtension(getClientId(request), request.body);
      response.status(201).json(info);
    } catch (error) {
      next(error);
    }
  },
);

app.delete("/api/settings/keyword-surfer-extension", async (request, response, next) => {
  try {
    await deleteKeywordSurferExtension(getClientId(request));
    response.json({ ok: true });
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
      progress: sources.map((source) => ({ source, label: REVIEW_SOURCE_LABELS[source], status: "queued" })),
    };
    reviewSearchJobs.set(job.jobId, job);
    response.status(202).json(publicReviewJob(job));

    void (async () => {
      job.status = "running";
      job.updatedAt = Date.now();
      try {
        const proxySettings = await getReviewProxyCredentials(clientId);
        job.result = await searchCompanyReviews(query, sources, proxySettings, (sourceProgress) => {
          job.progress = job.progress.map((item) => item.source === sourceProgress.source ? sourceProgress : item);
          job.updatedAt = Date.now();
        }, clientId);
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

app.get("/api/review-analysis/challenges/:challengeId/frame", async (request, response, next) => {
  try {
    const challengeId = z.string().uuid().parse(request.params.challengeId);
    const frame = await captureReviewChallengeFrame(challengeId, getClientId(request));
    response.set({
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "image/jpeg",
      "Content-Length": String(frame.byteLength),
    });
    response.send(frame);
  } catch (error) {
    next(error);
  }
});

app.post("/api/review-analysis/challenges/:challengeId/click", async (request, response, next) => {
  try {
    const challengeId = z.string().uuid().parse(request.params.challengeId);
    const coordinates = reviewChallengeClickSchema.parse(request.body);
    await clickReviewChallenge(challengeId, getClientId(request), coordinates.x, coordinates.y);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/review-analysis/challenges/:challengeId/scroll", async (request, response, next) => {
  try {
    const challengeId = z.string().uuid().parse(request.params.challengeId);
    const { deltaY } = reviewChallengeScrollSchema.parse(request.body);
    await scrollReviewChallenge(challengeId, getClientId(request), deltaY);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/review-analysis/challenges/:challengeId", (request, response, next) => {
  try {
    const challengeId = z.string().uuid().parse(request.params.challengeId);
    cancelReviewChallenge(challengeId, getClientId(request));
    response.status(204).end();
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
  for (const [jobId, job] of reviewProxyTestJobs) {
    if (job.updatedAt < cutoff && job.status !== "queued" && job.status !== "running") reviewProxyTestJobs.delete(jobId);
  }
  for (const [jobId, job] of googleTrendsJobs) {
    if (job.updatedAt < cutoff && job.status !== "queued" && job.status !== "running") googleTrendsJobs.delete(jobId);
  }
  for (const [jobId, job] of redditSearchJobs) {
    if (job.updatedAt < cutoff && job.status !== "queued" && job.status !== "running") redditSearchJobs.delete(jobId);
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
