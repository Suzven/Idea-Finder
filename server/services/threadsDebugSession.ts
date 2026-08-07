import type { Page } from "playwright";
import { AppError } from "../errors.js";

const SESSION_TTL_MS = 10 * 60_000;

interface StoredThreadsDebugSession {
  id: string;
  ownerId: string;
  page: Page;
  expiresAt: number;
  cancelled: boolean;
}

export interface ThreadsDebugSessionHandle {
  isCancelled(): boolean;
  close(): void;
}

const sessions = new Map<string, StoredThreadsDebugSession>();

function remove(entry: StoredThreadsDebugSession): void {
  if (sessions.get(entry.id) === entry) sessions.delete(entry.id);
}

function expireOldSessions(): void {
  const now = Date.now();
  for (const entry of sessions.values()) {
    if (entry.expiresAt <= now || entry.page.isClosed()) {
      entry.cancelled = true;
      remove(entry);
    }
  }
}

function getOwnedSession(id: string, ownerId: string): StoredThreadsDebugSession {
  expireOldSessions();
  const entry = sessions.get(id);
  if (!entry || entry.ownerId !== ownerId) {
    throw new AppError(404, "THREADS_DEBUG_SESSION_NOT_FOUND", "Диагностическая вкладка Chromium ещё не открыта или уже закрыта.");
  }
  if (entry.page.isClosed()) {
    entry.cancelled = true;
    remove(entry);
    throw new AppError(410, "THREADS_DEBUG_SESSION_CLOSED", "Диагностическая вкладка Chromium уже закрыта.");
  }
  return entry;
}

export function registerThreadsDebugSession(id: string, ownerId: string, page: Page): ThreadsDebugSessionHandle {
  expireOldSessions();
  for (const entry of sessions.values()) {
    if (entry.ownerId === ownerId) {
      entry.cancelled = true;
      void entry.page.close().catch(() => undefined);
      remove(entry);
    }
  }
  const entry: StoredThreadsDebugSession = {
    id,
    ownerId,
    page,
    expiresAt: Date.now() + SESSION_TTL_MS,
    cancelled: false,
  };
  sessions.set(id, entry);
  return {
    isCancelled: () => entry.cancelled || entry.page.isClosed(),
    close: () => remove(entry),
  };
}

export async function captureThreadsDebugFrame(id: string, ownerId: string): Promise<Buffer> {
  const entry = getOwnedSession(id, ownerId);
  try {
    return await entry.page.screenshot({ type: "jpeg", quality: 76, timeout: 8_000 });
  } catch (error) {
    throw new AppError(
      409,
      "THREADS_DEBUG_FRAME_BUSY",
      "Chromium обновляет ленту. Следующий кадр появится автоматически.",
      undefined,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

export async function cancelThreadsDebugSession(id: string, ownerId: string): Promise<void> {
  const entry = getOwnedSession(id, ownerId);
  entry.cancelled = true;
  remove(entry);
  await entry.page.close().catch(() => undefined);
}
