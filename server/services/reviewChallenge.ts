import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { ReviewManualChallenge } from "../../src/shared/types.js";
import { AppError } from "../errors.js";

const CHALLENGE_TTL_MS = 5 * 60_000;
const VIEWPORT_WIDTH = 1_440;
const VIEWPORT_HEIGHT = 1_000;

interface StoredReviewChallenge {
  id: string;
  clientId: string;
  page: Page;
  createdAt: number;
  expiresAt: number;
  cancelled: boolean;
}

export interface ReviewChallengeHandle {
  challenge: ReviewManualChallenge;
  isCancelled(): boolean;
  close(): void;
}

const challenges = new Map<string, StoredReviewChallenge>();

function removeChallenge(entry: StoredReviewChallenge): void {
  if (challenges.get(entry.id) === entry) challenges.delete(entry.id);
}

function expireOldChallenges(): void {
  const now = Date.now();
  for (const entry of challenges.values()) {
    if (entry.expiresAt <= now || entry.page.isClosed()) {
      entry.cancelled = true;
      removeChallenge(entry);
    }
  }
}

function getOwnedChallenge(id: string, clientId: string): StoredReviewChallenge {
  expireOldChallenges();
  const entry = challenges.get(id);
  if (!entry || entry.clientId !== clientId) {
    throw new AppError(404, "REVIEW_CHALLENGE_NOT_FOUND", "Окно ручной проверки уже закрыто или недоступно.");
  }
  if (entry.page.isClosed()) {
    entry.cancelled = true;
    removeChallenge(entry);
    throw new AppError(410, "REVIEW_CHALLENGE_CLOSED", "Вкладка Chromium уже закрыта.");
  }
  return entry;
}

export function registerReviewChallenge(clientId: string, page: Page): ReviewChallengeHandle {
  expireOldChallenges();
  for (const entry of challenges.values()) {
    if (entry.clientId === clientId) {
      entry.cancelled = true;
      removeChallenge(entry);
    }
  }

  const id = randomUUID();
  const createdAt = Date.now();
  const entry: StoredReviewChallenge = {
    id,
    clientId,
    page,
    createdAt,
    expiresAt: createdAt + CHALLENGE_TTL_MS,
    cancelled: false,
  };
  challenges.set(id, entry);
  const viewport = page.viewportSize() ?? { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };
  return {
    challenge: {
      id,
      source: "capterra",
      width: viewport.width,
      height: viewport.height,
      pageUrl: page.url(),
      expiresAt: new Date(entry.expiresAt).toISOString(),
    },
    isCancelled: () => entry.cancelled || entry.expiresAt <= Date.now() || entry.page.isClosed(),
    close: () => removeChallenge(entry),
  };
}

export async function captureReviewChallengeFrame(id: string, clientId: string): Promise<Buffer> {
  const entry = getOwnedChallenge(id, clientId);
  try {
    return await entry.page.screenshot({ type: "jpeg", quality: 78, animations: "disabled", timeout: 8_000 });
  } catch (error) {
    throw new AppError(
      409,
      "REVIEW_CHALLENGE_FRAME_BUSY",
      "Chromium обновляет страницу проверки. Кадр появится автоматически.",
      undefined,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

export async function clickReviewChallenge(id: string, clientId: string, x: number, y: number): Promise<void> {
  const entry = getOwnedChallenge(id, clientId);
  const viewport = entry.page.viewportSize() ?? { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };
  const safeX = Math.max(0, Math.min(viewport.width - 1, x));
  const safeY = Math.max(0, Math.min(viewport.height - 1, y));
  await entry.page.mouse.click(safeX, safeY);
}

export async function scrollReviewChallenge(id: string, clientId: string, deltaY: number): Promise<void> {
  const entry = getOwnedChallenge(id, clientId);
  await entry.page.mouse.wheel(0, Math.max(-1_500, Math.min(1_500, deltaY)));
}

export function cancelReviewChallenge(id: string, clientId: string): void {
  const entry = getOwnedChallenge(id, clientId);
  entry.cancelled = true;
  removeChallenge(entry);
}
