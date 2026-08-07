import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../errors.js";

const THREADS_AUTHORIZATION_URL = "https://threads.net/oauth/authorize";
const THREADS_TOKEN_URL = "https://graph.threads.net/oauth/access_token";
const THREADS_LONG_LIVED_TOKEN_URL = "https://graph.threads.net/access_token";
const THREADS_DEBUG_TOKEN_URL = "https://graph.threads.net/debug_token";
const THREADS_SCOPES = ["threads_basic", "threads_keyword_search", "threads_read_replies"] as const;
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const TOKEN_INSPECTION_TTL_MS = 5 * 60_000;

interface OAuthState {
  userId: string;
  redirectUri: string;
  expiresAt: number;
}

interface TokenPayload {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  user_id?: unknown;
  error?: {
    message?: unknown;
    type?: unknown;
    code?: unknown;
    error_subcode?: unknown;
    fbtrace_id?: unknown;
  };
}

interface DebugTokenPayload extends TokenPayload {
  data?: {
    app_id?: unknown;
    application?: unknown;
    expires_at?: unknown;
    data_access_expires_at?: unknown;
    is_valid?: unknown;
    scopes?: unknown;
    user_id?: unknown;
  };
}

export interface ThreadsTokenInspection {
  valid: boolean;
  scopes: string[];
  missingScopes: string[];
  appId?: string;
  expiresAt?: number;
  dataAccessExpiresAt?: number;
}

const oauthStates = new Map<string, OAuthState>();
const tokenInspections = new Map<string, { expiresAt: number; value: ThreadsTokenInspection }>();

function cleanupOAuthStates(): void {
  const now = Date.now();
  for (const [state, entry] of oauthStates) {
    if (entry.expiresAt <= now) oauthStates.delete(state);
  }
}

function tokenError(payload: TokenPayload, fallback: string): AppError {
  const message = typeof payload.error?.message === "string" ? payload.error.message : fallback;
  return new AppError(502, "THREADS_OAUTH_TOKEN_ERROR", "Meta не выдала Threads Access Token.", message, {
    metaCode: payload.error?.code,
    metaSubcode: payload.error?.error_subcode,
    metaType: payload.error?.type,
    fbtraceId: payload.error?.fbtrace_id,
  });
}

async function readTokenResponse(response: Response, fallback: string): Promise<TokenPayload> {
  const raw = await response.text();
  let payload: TokenPayload;
  try {
    payload = JSON.parse(raw) as TokenPayload;
  } catch {
    throw new AppError(502, "THREADS_OAUTH_INVALID_RESPONSE", "Meta вернула OAuth-ответ в неожиданном формате.", undefined, {
      httpStatus: response.status,
      responsePreview: raw.replace(/\s+/g, " ").slice(0, 500),
    });
  }
  if (!response.ok || payload.error) throw tokenError(payload, fallback);
  return payload;
}

export function createThreadsAuthorization(userId: string, appId: string, redirectUri: string): { authorizationUrl: string; state: string } {
  cleanupOAuthStates();
  const state = randomBytes(32).toString("base64url");
  oauthStates.set(state, { userId, redirectUri, expiresAt: Date.now() + OAUTH_STATE_TTL_MS });
  const url = new URL(THREADS_AUTHORIZATION_URL);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", THREADS_SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return { authorizationUrl: url.toString(), state };
}

export function consumeThreadsOAuthState(state: string, userId: string): OAuthState {
  cleanupOAuthStates();
  const entry = oauthStates.get(state);
  oauthStates.delete(state);
  if (!entry || entry.expiresAt <= Date.now() || entry.userId !== userId) {
    throw new AppError(400, "THREADS_OAUTH_STATE_INVALID", "Сессия подключения Threads устарела или недействительна.", "Вернитесь в настройки и нажмите «Подключить Threads» ещё раз.");
  }
  return entry;
}

export async function exchangeThreadsCode(code: string, redirectUri: string, appId: string, appSecret: string): Promise<string> {
  const shortUrl = new URL(THREADS_TOKEN_URL);
  shortUrl.searchParams.set("client_id", appId);
  shortUrl.searchParams.set("client_secret", appSecret);
  shortUrl.searchParams.set("code", code);
  shortUrl.searchParams.set("grant_type", "authorization_code");
  shortUrl.searchParams.set("redirect_uri", redirectUri);

  let shortResponse: Response;
  try {
    shortResponse = await fetch(shortUrl, { method: "POST", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new AppError(504, "THREADS_OAUTH_NETWORK_ERROR", "Сервер не дождался ответа OAuth Threads.", "Повторите подключение.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const shortPayload = await readTokenResponse(shortResponse, "Не удалось обменять OAuth-код на короткий токен.");
  const shortToken = typeof shortPayload.access_token === "string" ? shortPayload.access_token : "";
  if (!shortToken) throw tokenError(shortPayload, "Meta не вернула access_token.");

  const longUrl = new URL(THREADS_LONG_LIVED_TOKEN_URL);
  longUrl.searchParams.set("grant_type", "th_exchange_token");
  longUrl.searchParams.set("client_secret", appSecret);
  longUrl.searchParams.set("access_token", shortToken);

  let longResponse: Response;
  try {
    longResponse = await fetch(longUrl, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new AppError(504, "THREADS_OAUTH_NETWORK_ERROR", "Сервер не дождался долгоживущего токена Threads.", "Повторите подключение.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const longPayload = await readTokenResponse(longResponse, "Не удалось получить долгоживущий Threads-токен.");
  const longToken = typeof longPayload.access_token === "string" ? longPayload.access_token : "";
  if (!longToken) throw tokenError(longPayload, "Meta не вернула долгоживущий access_token.");
  return longToken;
}

function tokenCacheKey(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export async function inspectThreadsToken(token: string, force = false): Promise<ThreadsTokenInspection> {
  const cacheKey = tokenCacheKey(token);
  const cached = tokenInspections.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

  const url = new URL(THREADS_DEBUG_TOKEN_URL);
  url.searchParams.set("input_token", token);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new AppError(504, "THREADS_TOKEN_DEBUG_NETWORK_ERROR", "Не удалось проверить права Threads-токена.", "Повторите подключение через несколько секунд.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const raw = await response.text();
  let payload: DebugTokenPayload;
  try {
    payload = JSON.parse(raw) as DebugTokenPayload;
  } catch {
    throw new AppError(502, "THREADS_TOKEN_DEBUG_INVALID_RESPONSE", "Meta вернула неожиданный ответ при проверке Threads-токена.", undefined, {
      httpStatus: response.status,
      responsePreview: raw.replace(/\s+/g, " ").slice(0, 500),
    });
  }
  if (!response.ok || payload.error) {
    const message = typeof payload.error?.message === "string" ? payload.error.message : "Meta не смогла проверить Threads-токен.";
    throw new AppError(response.status === 401 ? 401 : 502, "THREADS_TOKEN_DEBUG_ERROR", message, "Отключите Threads и выполните OAuth заново.", {
      httpStatus: response.status,
      metaCode: payload.error?.code,
      metaSubcode: payload.error?.error_subcode,
      fbtraceId: payload.error?.fbtrace_id,
    });
  }
  const scopes = Array.isArray(payload.data?.scopes)
    ? payload.data.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  const value: ThreadsTokenInspection = {
    valid: payload.data?.is_valid === true,
    scopes,
    missingScopes: THREADS_SCOPES.filter((scope) => !scopes.includes(scope)),
    ...(typeof payload.data?.app_id === "string" ? { appId: payload.data.app_id } : {}),
    ...(typeof payload.data?.expires_at === "number" ? { expiresAt: payload.data.expires_at } : {}),
    ...(typeof payload.data?.data_access_expires_at === "number" ? { dataAccessExpiresAt: payload.data.data_access_expires_at } : {}),
  };
  tokenInspections.set(cacheKey, { expiresAt: Date.now() + TOKEN_INSPECTION_TTL_MS, value });
  return value;
}

export async function assertThreadsTokenPermissions(token: string, force = false): Promise<ThreadsTokenInspection> {
  const inspection = await inspectThreadsToken(token, force);
  if (!inspection.valid) {
    throw new AppError(401, "THREADS_TOKEN_INVALID", "Meta считает Threads-токен недействительным.", "Отключите Threads и подключите заново через OAuth.");
  }
  if (inspection.missingScopes.length) {
    throw new AppError(403, "THREADS_PERMISSION_MISSING", `Threads-токен не содержит права: ${inspection.missingScopes.join(", ")}.`, "Отключите Threads, удалите доступ SpyService в Threads и выполните OAuth заново.", {
      grantedScopes: inspection.scopes,
      missingScopes: inspection.missingScopes,
    });
  }
  return inspection;
}

export const requiredThreadsScopes = [...THREADS_SCOPES];
