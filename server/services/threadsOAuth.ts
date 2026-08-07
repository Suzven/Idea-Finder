import { randomBytes } from "node:crypto";
import { AppError } from "../errors.js";

const THREADS_AUTHORIZATION_URL = "https://threads.net/oauth/authorize";
const THREADS_TOKEN_URL = "https://graph.threads.net/oauth/access_token";
const THREADS_LONG_LIVED_TOKEN_URL = "https://graph.threads.net/access_token";
const THREADS_SCOPES = ["threads_basic", "threads_keyword_search", "threads_read_replies"] as const;
const OAUTH_STATE_TTL_MS = 10 * 60_000;

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

const oauthStates = new Map<string, OAuthState>();

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

export const requiredThreadsScopes = [...THREADS_SCOPES];
