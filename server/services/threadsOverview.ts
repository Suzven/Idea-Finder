import type { BrowserContext, BrowserContextOptions, Page } from "playwright";
import { AppError } from "../errors.js";
import type {
  ThreadsConversationResponse,
  ThreadsFeedLoadDiagnostic,
  ThreadsPost,
  ThreadsReply,
  ThreadsSearchRequest,
  ThreadsSearchResponse,
} from "../../src/shared/types.js";
import { getMetaBrowser } from "./metaSnapshot.js";

const THREADS_WEB_ORIGIN = "https://www.threads.com";
const SEARCH_TIMEOUT_MS = 30_000;
const SEARCH_RESULT_TIMEOUT_MS = 15_000;
const MAX_SEARCH_FEED_LOADS = 10;
const MAX_CONVERSATION_SCROLL_PASSES = 14;
const FEED_LOAD_TIMEOUT_MS = 40_000;
const FEED_IDLE_CONFIRM_MS = 3_500;
const FEED_SETTLE_MS = 900;
const LOGIN_TIMEOUT_MS = 25_000;
const DEFAULT_CONVERSATION_REPLIES = 100;
const MAX_CONVERSATION_REPLIES = 150;

let activeBrowserJobs = 0;
const browserJobWaiters: Array<() => void> = [];

interface ThreadsWebCard {
  id?: unknown;
  username?: unknown;
  text?: unknown;
  timestamp?: unknown;
  permalink?: unknown;
  mediaType?: unknown;
  mediaUrl?: unknown;
  thumbnailUrl?: unknown;
  topicTag?: unknown;
  linkAttachmentUrl?: unknown;
}

export interface ThreadsBrowserSession {
  username: string;
  password: string;
  storageState?: string;
  saveStorageState?: (storageState: string) => Promise<void>;
}

export interface ThreadsSessionStatus {
  authenticated: boolean;
  username: string;
  sessionSaved: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeHttpUrl(value: unknown): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw, THREADS_WEB_ORIGIN);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeThreadsWebPost(value: unknown): ThreadsPost | null {
  const item = asRecord(value) as ThreadsWebCard;
  const id = optionalString(item.id);
  const permalink = safeHttpUrl(item.permalink);
  if (!id || !permalink) return null;
  const mediaType = optionalString(item.mediaType);
  const mediaUrl = safeHttpUrl(item.mediaUrl);
  const thumbnailUrl = safeHttpUrl(item.thumbnailUrl);
  const linkAttachmentUrl = safeHttpUrl(item.linkAttachmentUrl);
  return {
    id,
    username: optionalString(item.username) ?? "threads_user",
    text: optionalString(item.text) ?? "",
    timestamp: optionalString(item.timestamp) ?? "",
    permalink,
    ...(mediaType ? { mediaType } : {}),
    ...(mediaUrl ? { mediaUrl } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(optionalString(item.topicTag) ? { topicTag: optionalString(item.topicTag) } : {}),
    ...(linkAttachmentUrl ? { linkAttachmentUrl } : {}),
  };
}

export function decodeThreadsWebCursor(cursor?: string): number {
  if (!cursor) return 0;
  const match = /^web:(\d{1,6})$/.exec(cursor);
  return match ? Number(match[1]) : 0;
}

async function acquireBrowserJob(): Promise<void> {
  if (activeBrowserJobs < 1) {
    activeBrowserJobs += 1;
    return;
  }
  await new Promise<void>((resolve) => browserJobWaiters.push(resolve));
  activeBrowserJobs += 1;
}

function releaseBrowserJob(): void {
  activeBrowserJobs = Math.max(0, activeBrowserJobs - 1);
  browserJobWaiters.shift()?.();
}

function parseStorageState(value?: string): BrowserContextOptions["storageState"] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { cookies?: unknown; origins?: unknown };
    if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) return undefined;
    return parsed as BrowserContextOptions["storageState"];
  } catch {
    return undefined;
  }
}

async function ensureThreadsAuthenticated(page: Page, session: ThreadsBrowserSession): Promise<void> {
  await gotoThreadsPage(page, `${THREADS_WEB_ORIGIN}/login`);
  await page.waitForTimeout(900);

  const usernameInput = page.locator('input[type="text"]:visible, input[type="email"]:visible').first();
  const passwordInput = page.locator('input[type="password"]:visible').first();
  const loginFormVisible = await passwordInput.isVisible().catch(() => false);
  if (loginFormVisible) {
    await usernameInput.fill(session.username, { timeout: 8_000 });
    await passwordInput.fill(session.password, { timeout: 8_000 });
    const submitButton = page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first();
    if (await submitButton.isVisible().catch(() => false)) {
      await submitButton.click({ timeout: 8_000 });
    } else {
      await passwordInput.press("Enter", { timeout: 8_000 });
    }
    await Promise.race([
      page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: LOGIN_TIMEOUT_MS }).catch(() => undefined),
      page.locator('input[type="password"]').waitFor({ state: "hidden", timeout: LOGIN_TIMEOUT_MS }).catch(() => undefined),
    ]);
    await page.waitForTimeout(1_200);
  }

  const currentUrl = page.url();
  const bodyText = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 2_000);
  const passwordStillVisible = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
  const challenge = /(?:введите код|код безопасности|подтвердите|проверьте уведомления|two-factor|security code|confirm your identity|check your notifications|challenge)/i.test(`${currentUrl} ${bodyText}`);
  if (challenge) {
    throw new AppError(
      409,
      "THREADS_LOGIN_CHALLENGE",
      "Threads запросил дополнительное подтверждение входа.",
      "Откройте Threads обычным браузером, подтвердите новый вход с VPS и повторите проверку в настройках.",
      { url: currentUrl },
    );
  }
  if (passwordStillVisible || currentUrl.includes("/login")) {
    const rejected = /(?:неверн|incorrect|invalid|wrong password|couldn't find|не удалось найти)/i.test(bodyText);
    throw new AppError(
      422,
      "THREADS_LOGIN_FAILED",
      rejected ? "Threads отклонил логин или пароль." : "Не удалось подтвердить вход в Threads.",
      rejected ? "Проверьте реквизиты в настройках." : "Повторите проверку. Если Threads прислал уведомление, подтвердите вход в приложении.",
      { url: currentUrl },
    );
  }
}

async function withThreadsPage<T>(
  operation: (page: Page, context: BrowserContext) => Promise<T>,
  session?: ThreadsBrowserSession,
  requireSessionSave = false,
): Promise<T> {
  await acquireBrowserJob();
  let context: BrowserContext | undefined;
  let authenticated = false;
  let sessionSaveError: unknown;
  try {
    const browser = await getMetaBrowser();
    const storageState = parseStorageState(session?.storageState);
    context = await browser.newContext({
      locale: "ru-RU",
      viewport: { width: 1440, height: 1100 },
      extraHTTPHeaders: { "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8" },
      ...(storageState ? { storageState } : {}),
    });
    const page = await context.newPage();
    if (session) {
      await ensureThreadsAuthenticated(page, session);
      authenticated = true;
    }
    return await operation(page, context);
  } finally {
    if (authenticated && context && session?.saveStorageState) {
      const state = JSON.stringify(await context.storageState());
      try {
        await session.saveStorageState(state);
      } catch (error) {
        sessionSaveError = error;
        if (!requireSessionSave) console.error("Не удалось сохранить сессию Threads:", error);
      }
    }
    await context?.close().catch(() => undefined);
    releaseBrowserJob();
    if (requireSessionSave && sessionSaveError) {
      throw new AppError(500, "THREADS_SESSION_SAVE_FAILED", "Вход выполнен, но сохранить cookies Threads не удалось.", "Проверьте миграцию базы данных и повторите вход.");
    }
  }
}

export async function initializeThreadsSession(session: ThreadsBrowserSession): Promise<ThreadsSessionStatus> {
  return withThreadsPage(async () => ({
    authenticated: true,
    username: session.username,
    sessionSaved: true,
  }), session, true);
}

function threadsWebError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/Timeout|timed out/i.test(message)) {
    return new AppError(504, "THREADS_WEB_TIMEOUT", "Публичная страница Threads не успела загрузиться.", "Повторите запрос через несколько секунд.", { cause: message });
  }
  return new AppError(502, "THREADS_WEB_FAILED", "Не удалось получить публичную выдачу Threads.", "Повторите запрос. Если ошибка сохранится, проверьте доступ сервера к threads.com.", { cause: message });
}

function buildSearchUrl(request: ThreadsSearchRequest): string {
  const url = new URL("/search", THREADS_WEB_ORIGIN);
  url.searchParams.set("q", request.query);
  url.searchParams.set("serp_type", request.searchMode === "TAG" ? "tags" : request.searchType === "RECENT" ? "recent" : "default");
  return url.toString();
}

async function gotoThreadsPage(page: Page, url: string): Promise<void> {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
  if (response && response.status() >= 400) {
    throw new AppError(502, "THREADS_WEB_HTTP_ERROR", `Threads вернул HTTP ${response.status()} для публичной страницы.`, "Повторите запрос позже.", {
      url: response.url(),
      httpStatus: response.status(),
    });
  }
}

async function waitForPublicCards(page: Page): Promise<boolean> {
  try {
    await page.locator('a[href*="/post/"] time').first().waitFor({ state: "attached", timeout: SEARCH_RESULT_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function scrapeVisibleCards(page: Page, conversationOnly = false): Promise<ThreadsPost[]> {
  const rawCards = await page.evaluate((onlyConversation) => {
    const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const ignoredText = /^(?:Перевести|Translate|See translation|Нравится|Ответить|Поделиться|Like|Reply|Share)$/i;
    const dateOrRelativeTime = /^(?:\d+\s*(?:сек\.?|с\.?|мин\.?|ч\.?|дн\.?|нед\.?|мес\.?|г\.?|s|m|h|d|w)|\d{1,2}[./]\d{1,2}[./]\d{2,4})$/i;
    const result: Array<Record<string, string>> = [];
    const seen = new Set<string>();
    const relatedMarker = onlyConversation
      ? [...document.querySelectorAll<HTMLElement>("body *")].find((node) => node.children.length === 0 && /^(?:Связанные ветки|Related threads)$/i.test(clean(node.textContent)))
      : undefined;
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/post/"]')].filter((link) => link.querySelector("time"));
    for (const link of links) {
      const permalink = new URL(link.href, location.href).toString();
      const parsed = new URL(permalink);
      const match = /^\/@([^/]+)\/post\/([^/?#]+)/.exec(parsed.pathname);
      if (!match || seen.has(permalink)) continue;
      const card = link.closest<HTMLElement>('[data-pressable-container="true"]');
      if (!card) continue;
      if (relatedMarker && (relatedMarker.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      seen.add(permalink);
      const username = decodeURIComponent(match[1]);
      const timestamp = link.querySelector("time")?.getAttribute("datetime") ?? "";
      const textParts: string[] = [];
      for (const node of card.querySelectorAll<HTMLElement>('[dir="auto"]')) {
        if (node.closest("a,button,[role=button],time") || node.querySelector('[dir="auto"]')) continue;
        const text = clean(node.innerText || node.textContent);
        if (!text || text === username || ignoredText.test(text) || dateOrRelativeTime.test(text) || /^\d+[,.]?\d*[KMB]?$/i.test(text)) continue;
        const withoutTranslation = text.replace(/\s*(?:Перевести|Translate|See translation)\s*$/i, "").trim();
        if (withoutTranslation && !textParts.includes(withoutTranslation)) textParts.push(withoutTranslation);
      }
      const video = card.querySelector<HTMLVideoElement>("video");
      const mediaImage = card.querySelector<HTMLImageElement>('a[href$="/media"] img, a[href*="/media?"] img');
      const tagLink = card.querySelector<HTMLAnchorElement>('a[href*="serp_type=tags"]');
      const externalLink = [...card.querySelectorAll<HTMLAnchorElement>("a[href]")].find((candidate) => {
        try {
          const host = new URL(candidate.href, location.href).hostname.toLowerCase();
          return host !== "threads.com" && !host.endsWith(".threads.com") && host !== "threads.net" && !host.endsWith(".threads.net") && host !== "instagram.com" && !host.endsWith(".instagram.com");
        } catch { return false; }
      });
      result.push({
        id: match[2],
        username,
        text: textParts.join("\n"),
        timestamp,
        permalink,
        mediaType: video ? "VIDEO" : mediaImage ? "IMAGE" : "",
        mediaUrl: video?.currentSrc || video?.src || video?.querySelector("source")?.src || mediaImage?.currentSrc || mediaImage?.src || "",
        thumbnailUrl: video?.poster || mediaImage?.currentSrc || mediaImage?.src || "",
        topicTag: clean(tagLink?.textContent),
        linkAttachmentUrl: externalLink?.href || "",
      });
    }
    return result;
  }, conversationOnly);
  return rawCards.map(normalizeThreadsWebPost).filter((post): post is ThreadsPost => Boolean(post));
}

interface FeedSnapshot {
  postCount: number;
  postUrls: string[];
  height: number;
  lastPostUrl: string;
  loading: boolean;
  loaderCount: number;
  visibleLoaderCount: number;
  bottomGap: number;
}

async function feedSnapshot(page: Page): Promise<FeedSnapshot> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const node = element as HTMLElement;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0
        && rect.height > 0
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity) !== 0;
    };
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/post/"]')].filter((link) => link.querySelector("time"));
    const postUrls = [...new Set(links.map((link) => link.href))];
    const explicitLoaders = document.querySelectorAll([
      '[role="progressbar"]',
      '[aria-label*="loading" i]',
      '[aria-label*="загрузка" i]',
      '[data-visualcompletion="loading-state"]',
    ].join(","));
    const visibleLoaders = [...explicitLoaders].filter(visible);
    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const scrollBottom = window.scrollY + window.innerHeight;
    return {
      postCount: postUrls.length,
      postUrls,
      height,
      lastPostUrl: postUrls.at(-1) ?? "",
      loading: visibleLoaders.length > 0,
      loaderCount: explicitLoaders.length,
      visibleLoaderCount: visibleLoaders.length,
      bottomGap: Math.max(0, Math.round(height - scrollBottom)),
    };
  });
}

async function scrollThreadsFeedToEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/post/"]')].filter((link) => link.querySelector("time"));
    // Threads leaves old loaders mounted outside the viewport. Scrolling to one
    // of them can jump back into an already loaded part of the virtualized feed.
    const target = links.at(-1);
    target?.scrollIntoView({ block: "end", behavior: "instant" });

    let ancestor = target?.parentElement;
    while (ancestor) {
      const style = getComputedStyle(ancestor);
      if (ancestor.scrollHeight > ancestor.clientHeight + 8 && /(auto|scroll)/.test(style.overflowY)) {
        ancestor.scrollTop = ancestor.scrollHeight;
      }
      ancestor = ancestor.parentElement;
    }

    const scrollingElement = document.scrollingElement;
    scrollingElement?.scrollTo({ top: scrollingElement.scrollHeight, behavior: "instant" });
    window.scrollTo({ top: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight), behavior: "instant" });
  });
}

interface FeedLoadResult {
  loaded: boolean;
  timedOut: boolean;
  diagnostic: Omit<ThreadsFeedLoadDiagnostic, "newUniquePosts" | "collectedTotal">;
}

async function loadNextFeedPage(
  page: Page,
  pass: number,
  collectVisible?: () => Promise<void>,
): Promise<FeedLoadResult> {
  const before = await feedSnapshot(page);
  const observedPostUrls = new Set(before.postUrls);
  await scrollThreadsFeedToEnd(page);

  const startedAt = Date.now();
  let contentChanged = false;
  let sawLoader = before.loading;
  let lastChangeAt = 0;
  let loaderFinishedAt = 0;
  let lastNewPostAt = 0;
  let previous = before;
  let latest = before;
  const finish = (outcome: ThreadsFeedLoadDiagnostic["outcome"], reason: string): FeedLoadResult => ({
    loaded: outcome === "loaded" || (outcome === "timeout" && contentChanged),
    timedOut: outcome === "timeout",
    diagnostic: {
      pass,
      durationMs: Date.now() - startedAt,
      outcome,
      reason,
      beforeDomPosts: before.postCount,
      afterDomPosts: latest.postCount,
      beforeHeight: before.height,
      afterHeight: latest.height,
      beforeBottomGap: before.bottomGap,
      afterBottomGap: latest.bottomGap,
      loadersInDom: latest.loaderCount,
      loadersInViewport: latest.visibleLoaderCount,
      sawLoader,
      loaderFinished: sawLoader && !latest.loading,
      lastPostChanged: Boolean(latest.lastPostUrl && latest.lastPostUrl !== before.lastPostUrl),
    },
  });
  while (Date.now() - startedAt < FEED_LOAD_TIMEOUT_MS) {
    await page.waitForTimeout(250);
    const current = await feedSnapshot(page);
    latest = current;
    const newPostUrls = current.postUrls.filter((url) => !observedPostUrls.has(url));
    for (const url of newPostUrls) observedPostUrls.add(url);
    if (newPostUrls.length > 0) {
      contentChanged = true;
      lastNewPostAt = Date.now();
      await collectVisible?.();
    }
    const changedSincePrevious = current.postCount !== previous.postCount
      || Math.abs(current.height - previous.height) > 8
      || current.lastPostUrl !== previous.lastPostUrl;
    if (changedSincePrevious) lastChangeAt = Date.now();
    if (changedSincePrevious || current.bottomGap > 120) {
      await scrollThreadsFeedToEnd(page);
      await page.waitForTimeout(100);
      latest = await feedSnapshot(page);
      const postScrollUrls = latest.postUrls.filter((url) => !observedPostUrls.has(url));
      for (const url of postScrollUrls) observedPostUrls.add(url);
      if (postScrollUrls.length > 0) {
        contentChanged = true;
        lastNewPostAt = Date.now();
        await collectVisible?.();
      }
    }
    if (latest.loading) {
      sawLoader = true;
      loaderFinishedAt = 0;
    } else if (sawLoader) {
      loaderFinishedAt ||= Date.now();
    }
    const stableSince = Math.max(lastChangeAt, lastNewPostAt);
    if (contentChanged && Date.now() - stableSince >= FEED_SETTLE_MS) {
      await collectVisible?.();
      return finish("loaded", latest.loading
        ? "Новые уникальные URL постов получены, лента стабилизировалась. Оставшийся индикатор признан служебным и не блокирует следующую прокрутку."
        : "Новые уникальные URL постов получены, лента стабилизировалась и готова к следующей прокрутке.");
    }
    if (!contentChanged && sawLoader && loaderFinishedAt && Date.now() - loaderFinishedAt >= FEED_SETTLE_MS) {
      return finish("end", "Индикатор загрузки завершился, но новых URL постов и изменений ленты не появилось.");
    }
    if (!contentChanged && !sawLoader && Date.now() - startedAt >= FEED_IDLE_CONFIRM_MS) {
      return finish("end", "После прокрутки индикатор не появился и лента не изменилась.");
    }
    previous = latest;
  }
  const timedOut = finish("timeout", latest.loading
    ? "Через 40 секунд индикатор загрузки всё ещё виден."
    : contentChanged
      ? "Контент менялся, но лента не успела стабилизироваться за 40 секунд."
      : "За 40 секунд Threads не завершил подгрузку и не показал новый контент.");
  return timedOut;
}

interface CollectedCards {
  posts: ThreadsPost[];
  loadedPages: number;
  loadTimedOut: boolean;
  feedLoads: ThreadsFeedLoadDiagnostic[];
}

async function collectCards(
  page: Page,
  targetCount: number,
  conversationOnly = false,
  maxLoadPasses = MAX_CONVERSATION_SCROLL_PASSES,
  stopAtTarget = true,
): Promise<CollectedCards> {
  const collected = new Map<string, ThreadsPost>();
  let loadedPages = 1;
  let loadTimedOut = false;
  const feedLoads: ThreadsFeedLoadDiagnostic[] = [];
  const collectVisible = async () => {
    for (const post of await scrapeVisibleCards(page, conversationOnly)) collected.set(post.permalink, post);
  };
  await collectVisible();
  for (let loadPass = 0; loadPass < maxLoadPasses; loadPass += 1) {
    if (stopAtTarget && collected.size >= targetCount) break;
    const collectedBefore = collected.size;
    const result = await loadNextFeedPage(page, loadPass + 1, collectVisible);
    if (result.loaded) {
      loadedPages += 1;
      await collectVisible();
    }
    feedLoads.push({
      ...result.diagnostic,
      newUniquePosts: collected.size - collectedBefore,
      collectedTotal: collected.size,
    });
    if (result.timedOut) {
      loadTimedOut = true;
      break;
    }
    if (!result.loaded) break;
  }
  await collectVisible();
  return { posts: [...collected.values()], loadedPages, loadTimedOut, feedLoads };
}

function withinDateRange(post: ThreadsPost, since?: string, until?: string): boolean {
  if (!since && !until) return true;
  const value = Date.parse(post.timestamp);
  if (!Number.isFinite(value)) return true;
  if (since && value < Date.parse(since)) return false;
  if (until && value > Date.parse(until)) return false;
  return true;
}

export async function searchThreadsPosts(request: ThreadsSearchRequest, session?: ThreadsBrowserSession): Promise<ThreadsSearchResponse> {
  return withThreadsPage(async (page) => {
    try {
      const url = buildSearchUrl(request);
      await gotoThreadsPage(page, url);
      const hasCards = await waitForPublicCards(page);
      if (!hasCards) {
        const pageText = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600);
        return {
          source: "web",
          accessMode: session ? "authenticated" : "public",
          query: request.query,
          posts: [],
          warnings: [session
            ? "Авторизованная выдача Threads не нашла постов по этому запросу."
            : "Публичная веб-выдача Threads не нашла постов по этому запросу."],
          appliedFilters: { searchType: request.searchType, searchMode: request.searchMode, ...(request.since ? { since: request.since } : {}), ...(request.until ? { until: request.until } : {}), fallback: false },
          diagnostics: { url, pagePreview: pageText },
        };
      }
      const maxPages = Math.max(1, Math.min(50, Math.floor(request.maxPages || MAX_SEARCH_FEED_LOADS)));
      const collected = await collectCards(page, Number.MAX_SAFE_INTEGER, false, maxPages, false);
      const allPosts = collected.posts
        .filter((post) => withinDateRange(post, request.since, request.until));
      if (request.searchType === "RECENT") {
        allPosts.sort((left, right) => (Date.parse(right.timestamp) || 0) - (Date.parse(left.timestamp) || 0));
      }
      const warnings = [session
        ? "Данные собраны через авторизованную сессию Threads в Chromium."
        : "Данные собраны из публичной веб-выдачи Threads через Chromium."];
      if (request.since || request.until) warnings.push("Диапазон дат применён локально к датам найденных постов.");
      if (collected.loadTimedOut) warnings.push("Одна из подгрузок Threads не завершилась за 40 секунд; сохранены все посты, успевшие появиться в ленте. Подробности находятся в диагностическом DOM-логе.");
      if (!session && allPosts.length < request.limit) warnings.push("Threads ограничил публичную выдачу; показаны все посты, доступные серверу в этой сессии.");
      return {
        source: "web",
        accessMode: session ? "authenticated" : "public",
        query: request.query,
        posts: allPosts,
        warnings,
        appliedFilters: { searchType: request.searchType, searchMode: request.searchMode, ...(request.since ? { since: request.since } : {}), ...(request.until ? { until: request.until } : {}), fallback: false },
        diagnostics: {
          url,
          collected: allPosts.length,
          loadedPages: collected.loadedPages,
          loadTimedOut: collected.loadTimedOut,
          feedLoads: collected.feedLoads,
        },
      };
    } catch (error) {
      throw threadsWebError(error);
    }
  }, session);
}

function validatePostPermalink(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const validHost = host === "threads.com" || host.endsWith(".threads.com") || host === "threads.net" || host.endsWith(".threads.net");
    if (!validHost || !/^\/@[^/]+\/post\/[^/?#]+/.test(url.pathname)) throw new Error("invalid permalink");
    url.protocol = "https:";
    return url.toString();
  } catch {
    throw new AppError(400, "THREADS_POST_URL_INVALID", "Некорректная публичная ссылка на пост Threads.");
  }
}

export async function fetchThreadsConversation(
  post: ThreadsPost,
  session?: ThreadsBrowserSession,
  requestedReplyLimit = DEFAULT_CONVERSATION_REPLIES,
): Promise<ThreadsConversationResponse> {
  return withThreadsPage(async (page) => {
    try {
      const replyLimit = Math.max(1, Math.min(MAX_CONVERSATION_REPLIES, Math.floor(requestedReplyLimit)));
      const url = validatePostPermalink(post.permalink);
      await gotoThreadsPage(page, url);
      const hasCards = await waitForPublicCards(page);
      if (!hasCards) {
        return { post, replies: [], warnings: [session ? "Threads не отдал ответы для этого поста в авторизованной сессии." : "Threads не отдал публичные ответы для этого поста."], truncated: false };
      }
      const { posts: cards } = await collectCards(page, replyLimit + 2, true);
      const replyCards = cards.filter((item) => item.id !== post.id && item.permalink !== post.permalink);
      const replies: ThreadsReply[] = replyCards
        .slice(0, replyLimit)
        .map((item) => ({ ...item, parentId: post.id, depth: 0 }));
      const truncated = replyCards.length > replyLimit;
      return {
        post,
        replies,
        warnings: [
          session ? "Ответы собраны через авторизованную сессию Threads в Chromium." : "Ответы собраны с публичной страницы поста Threads через Chromium.",
          ...(truncated ? [`Для выгрузки оставлены первые ${replyLimit} ответов.`] : []),
        ],
        truncated,
      };
    } catch (error) {
      throw threadsWebError(error);
    }
  }, session);
}
