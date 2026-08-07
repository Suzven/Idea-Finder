import type { BrowserContext, Page } from "playwright";
import { AppError } from "../errors.js";
import type {
  ThreadsConversationResponse,
  ThreadsPost,
  ThreadsReply,
  ThreadsSearchRequest,
  ThreadsSearchResponse,
} from "../../src/shared/types.js";
import { getMetaBrowser } from "./metaSnapshot.js";

const THREADS_WEB_ORIGIN = "https://www.threads.com";
const SEARCH_TIMEOUT_MS = 30_000;
const SEARCH_RESULT_TIMEOUT_MS = 15_000;
const MAX_SEARCH_FEED_PAGES = 10;
const MAX_CONVERSATION_SCROLL_PASSES = 14;
const FEED_LOAD_TIMEOUT_MS = 8_000;
const MAX_CONVERSATION_REPLIES = 250;

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

function encodeThreadsWebCursor(offset: number): string {
  return `web:${Math.max(0, Math.floor(offset))}`;
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

async function withThreadsPage<T>(operation: (page: Page, context: BrowserContext) => Promise<T>): Promise<T> {
  await acquireBrowserJob();
  let context: BrowserContext | undefined;
  try {
    const browser = await getMetaBrowser();
    context = await browser.newContext({
      locale: "ru-RU",
      viewport: { width: 1440, height: 1100 },
      extraHTTPHeaders: { "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8" },
    });
    const page = await context.newPage();
    return await operation(page, context);
  } finally {
    await context?.close().catch(() => undefined);
    releaseBrowserJob();
  }
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
  height: number;
  lastPostUrl: string;
  loading: boolean;
}

async function feedSnapshot(page: Page): Promise<FeedSnapshot> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const node = element as HTMLElement;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/post/"]')].filter((link) => link.querySelector("time"));
    const explicitLoaders = document.querySelectorAll([
      '[role="progressbar"]',
      '[aria-label*="loading" i]',
      '[aria-label*="загрузка" i]',
      '[data-visualcompletion="loading-state"]',
    ].join(","));
    const animatedBottomLoader = [...document.querySelectorAll<HTMLElement>("body *")].some((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.top < innerHeight * 0.55 || rect.top > innerHeight || rect.width > 80 || rect.height > 80 || !visible(element)) return false;
      const style = getComputedStyle(element);
      return style.animationName !== "none" && Number.parseFloat(style.animationDuration) > 0;
    });
    return {
      postCount: links.length,
      height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      lastPostUrl: links.at(-1)?.href ?? "",
      loading: [...explicitLoaders].some(visible) || animatedBottomLoader,
    };
  });
}

async function loadNextFeedPage(page: Page): Promise<boolean> {
  const before = await feedSnapshot(page);
  await page.evaluate(() => {
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/post/"]')].filter((link) => link.querySelector("time"));
    links.at(-1)?.scrollIntoView({ block: "end", behavior: "instant" });
    window.scrollTo({ top: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight), behavior: "instant" });
  });

  const startedAt = Date.now();
  let contentChanged = false;
  let settledAt = 0;
  while (Date.now() - startedAt < FEED_LOAD_TIMEOUT_MS) {
    await page.waitForTimeout(250);
    const current = await feedSnapshot(page);
    const changed = current.postCount > before.postCount
      || current.height > before.height + 8
      || Boolean(current.lastPostUrl && current.lastPostUrl !== before.lastPostUrl);
    if (changed) {
      contentChanged = true;
      settledAt ||= Date.now();
    }
    if (contentChanged && !current.loading && Date.now() - settledAt >= 700) return true;
    if (!contentChanged && !current.loading && Date.now() - startedAt >= 2_500) return false;
  }
  return contentChanged;
}

interface CollectedCards {
  posts: ThreadsPost[];
  loadedPages: number;
}

async function collectCards(
  page: Page,
  targetCount: number,
  conversationOnly = false,
  maxPages = MAX_CONVERSATION_SCROLL_PASSES + 1,
  stopAtTarget = true,
): Promise<CollectedCards> {
  const collected = new Map<string, ThreadsPost>();
  let stablePasses = 0;
  let loadedPages = 1;
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const before = collected.size;
    for (const post of await scrapeVisibleCards(page, conversationOnly)) collected.set(post.permalink, post);
    stablePasses = collected.size === before ? stablePasses + 1 : 0;
    if (stablePasses >= 2 || pageNumber === maxPages || (stopAtTarget && collected.size >= targetCount)) break;
    const loaded = await loadNextFeedPage(page);
    if (loaded) loadedPages += 1;
    else stablePasses += 1;
  }
  for (const post of await scrapeVisibleCards(page, conversationOnly)) collected.set(post.permalink, post);
  return { posts: [...collected.values()], loadedPages };
}

function withinDateRange(post: ThreadsPost, since?: string, until?: string): boolean {
  if (!since && !until) return true;
  const value = Date.parse(post.timestamp);
  if (!Number.isFinite(value)) return true;
  if (since && value < Date.parse(since)) return false;
  if (until && value > Date.parse(until)) return false;
  return true;
}

export async function searchThreadsPosts(request: ThreadsSearchRequest): Promise<ThreadsSearchResponse> {
  return withThreadsPage(async (page) => {
    try {
      const url = buildSearchUrl(request);
      await gotoThreadsPage(page, url);
      const hasCards = await waitForPublicCards(page);
      if (!hasCards) {
        const pageText = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600);
        return {
          source: "web",
          query: request.query,
          posts: [],
          warnings: ["Публичная веб-выдача Threads не нашла постов по этому запросу."],
          appliedFilters: { searchType: request.searchType, searchMode: request.searchMode, ...(request.since ? { since: request.since } : {}), ...(request.until ? { until: request.until } : {}), fallback: false },
          diagnostics: { url, pagePreview: pageText },
        };
      }
      const offset = decodeThreadsWebCursor(request.after);
      const collected = await collectCards(page, Number.MAX_SAFE_INTEGER, false, MAX_SEARCH_FEED_PAGES, false);
      const allPosts = collected.posts
        .filter((post) => withinDateRange(post, request.since, request.until));
      if (request.searchType === "RECENT") {
        allPosts.sort((left, right) => (Date.parse(right.timestamp) || 0) - (Date.parse(left.timestamp) || 0));
      }
      const posts = allPosts.slice(offset, offset + request.limit);
      const hasMore = allPosts.length > offset + request.limit;
      const warnings = ["Данные собраны из публичной веб-выдачи Threads через Chromium."];
      if (request.since || request.until) warnings.push("Диапазон дат применён локально к датам найденных публичных постов.");
      if (posts.length < request.limit) warnings.push("Threads ограничил публичную выдачу; показаны все посты, доступные серверу в этой сессии.");
      return {
        source: "web",
        query: request.query,
        posts,
        ...(hasMore ? { nextCursor: encodeThreadsWebCursor(offset + request.limit) } : {}),
        warnings,
        appliedFilters: { searchType: request.searchType, searchMode: request.searchMode, ...(request.since ? { since: request.since } : {}), ...(request.until ? { until: request.until } : {}), fallback: false },
        diagnostics: { url, collected: allPosts.length, loadedPages: collected.loadedPages },
      };
    } catch (error) {
      throw threadsWebError(error);
    }
  });
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

export async function fetchThreadsConversation(post: ThreadsPost): Promise<ThreadsConversationResponse> {
  return withThreadsPage(async (page) => {
    try {
      const url = validatePostPermalink(post.permalink);
      await gotoThreadsPage(page, url);
      const hasCards = await waitForPublicCards(page);
      if (!hasCards) {
        return { post, replies: [], warnings: ["Threads не отдал публичные ответы для этого поста."], truncated: false };
      }
      const { posts: cards } = await collectCards(page, MAX_CONVERSATION_REPLIES + 1, true);
      const replies: ThreadsReply[] = cards
        .filter((item) => item.id !== post.id && item.permalink !== post.permalink)
        .slice(0, MAX_CONVERSATION_REPLIES)
        .map((item) => ({ ...item, parentId: post.id, depth: 0 }));
      const truncated = cards.length > MAX_CONVERSATION_REPLIES;
      return {
        post,
        replies,
        warnings: [
          "Ответы собраны с публичной страницы поста Threads через Chromium.",
          ...(truncated ? [`Для выгрузки оставлены первые ${MAX_CONVERSATION_REPLIES} публичных ответов.`] : []),
        ],
        truncated,
      };
    } catch (error) {
      throw threadsWebError(error);
    }
  });
}
