import type express from "express";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { AuthUser } from "../src/shared/types.js";
import { AppError } from "./errors.js";
import { createUserSession, deleteUserSession, findUserBySessionHash, type StoredUser } from "./db.js";

const scryptAsync = promisify(scrypt);
const SESSION_COOKIE = "spyservice_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const authenticatedUsers = new WeakMap<express.Request, StoredUser>();
const failedLogins = new Map<string, { count: number; resetAt: number; blockedUntil: number }>();

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cookieValue(request: express.Request, name: string): string | undefined {
  const raw = request.header("cookie") ?? "";
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

function secureRequest(request: express.Request): boolean {
  return request.secure || String(request.header("x-forwarded-proto") ?? "").split(",")[0].trim() === "https";
}

function publicUser(user: StoredUser): AuthUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  };
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, version, saltValue, hashValue] = encoded.split("$");
  if (algorithm !== "scrypt" || version !== "v1" || !saltValue || !hashValue) return false;
  try {
    const expected = Buffer.from(hashValue, "base64url");
    const actual = await scryptAsync(password, Buffer.from(saltValue, "base64url"), expected.length) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function startSession(request: express.Request, response: express.Response, user: StoredUser): Promise<AuthUser> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await createUserSession(user.id, tokenHash(token), expiresAt);
  const secure = secureRequest(request) ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`,
  );
  return publicUser(user);
}

export async function endSession(request: express.Request, response: express.Response): Promise<void> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) await deleteUserSession(tokenHash(token));
  const secure = secureRequest(request) ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

export async function optionalAuthentication(request: express.Request): Promise<AuthUser | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const user = await findUserBySessionHash(tokenHash(token));
  if (!user) return null;
  authenticatedUsers.set(request, user);
  return publicUser(user);
}

export async function requireAuthentication(request: express.Request, _response: express.Response, next: express.NextFunction): Promise<void> {
  try {
    if (!await optionalAuthentication(request)) throw new AppError(401, "AUTH_REQUIRED", "Войдите в аккаунт.");
    next();
  } catch (error) {
    next(error);
  }
}

export function getAuthenticatedUser(request: express.Request): StoredUser {
  const user = authenticatedUsers.get(request);
  if (!user) throw new AppError(401, "AUTH_REQUIRED", "Войдите в аккаунт.");
  return user;
}

export function loginThrottleKey(request: express.Request, username: string): string {
  return `${request.ip}:${username.toLocaleLowerCase("en")}`;
}

export function assertLoginAllowed(key: string): void {
  const state = failedLogins.get(key);
  if (!state) return;
  if (state.resetAt <= Date.now()) {
    failedLogins.delete(key);
    return;
  }
  if (state.blockedUntil > Date.now()) {
    throw new AppError(429, "LOGIN_RATE_LIMITED", "Слишком много неудачных попыток входа.", "Повторите через 15 минут.");
  }
}

export function recordFailedLogin(key: string): void {
  const current = failedLogins.get(key);
  const now = Date.now();
  const count = current && current.resetAt > now ? current.count + 1 : 1;
  const resetAt = current && current.resetAt > now ? current.resetAt : now + 15 * 60_000;
  failedLogins.set(key, { count, resetAt, blockedUntil: count >= 5 ? resetAt : 0 });
}

export function clearFailedLogins(key: string): void {
  failedLogins.delete(key);
}
