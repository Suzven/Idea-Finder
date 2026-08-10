import type { BrowserContext, Page } from "playwright";
import { AppError } from "../errors.js";
import type {
  RedditComment,
  RedditConversationResponse,
  RedditLogEntry,
  RedditPost,
  RedditSearchRequest,
  RedditSearchResponse,
} from "../../src/shared/types.js";
import { createContext, type ReviewProxyCredentials } from "./reviewAnalysis.js";

const REDDIT_ORIGINS = ["https://www.reddit.com", "https://old.reddit.com"];
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_COMMENTS_PER_POST = 1_000;
const USER_AGENT = process.env.SPYSERVICE_REDDIT_USER_AGENT?.trim()
  || "SpyService/1.0 (public Reddit research; +https://ideafinder.mvppanel.store)";

type UnknownRecord = Record<string, unknown>;
type RedditLogger = (
  stage: string,
  status: RedditLogEntry["status"],
  message: string,
  details?: RedditLogEntry["details"],
) => void;

function createRedditDiagnostics(
  onProgress?: (logs: RedditLogEntry[]) => void,
): { logs: RedditLogEntry[]; log: RedditLogger } {
  const startedAt = Date.now();
  const logs: RedditLogEntry[] = [];
  return {
    logs,
    log(stage, status, message, details) {
      logs.push({
        at: new Date().toISOString(),
        stage,
        status,
        message,
        elapsedMs: Date.now() - startedAt,
        ...(details ? { details } : {}),
      });
      onProgress?.([...logs]);
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function absoluteRedditUrl(value: unknown): string {
  const candidate = text(value);
  if (!candidate) return "";
  try {
    return new URL(candidate, "https://www.reddit.com").toString();
  } catch {
    return "";
  }
}

function safeMediaUrl(value: unknown): string | undefined {
  const candidate = text(value).replaceAll("&amp;", "&");
  if (!/^https?:\/\//i.test(candidate)) return undefined;
  try {
    return new URL(candidate).toString();
  } catch {
    return undefined;
  }
}

function timestamp(value: unknown): string {
  const seconds = numberValue(value);
  return seconds > 0 ? new Date(seconds * 1_000).toISOString() : "";
}

function previewFrom(data: UnknownRecord): string | undefined {
  const preview = record(data.preview);
  const images = Array.isArray(preview?.images) ? preview.images : [];
  const first = record(images[0]);
  const source = record(first?.source);
  return safeMediaUrl(source?.url) ?? safeMediaUrl(data.thumbnail);
}

export function normalizeRedditPost(value: unknown): RedditPost | null {
  const wrapper = record(value);
  const data = record(wrapper?.data ?? value);
  if (!data) return null;
  const id = text(data.id);
  const permalink = absoluteRedditUrl(data.permalink);
  if (!id || !permalink) return null;
  const destinationUrl = safeMediaUrl(data.url_overridden_by_dest ?? data.url);
  return {
    id,
    title: text(data.title) || "Публикация без заголовка",
    text: text(data.selftext),
    author: text(data.author) || "deleted",
    subreddit: text(data.subreddit_name_prefixed) || (text(data.subreddit) ? `r/${text(data.subreddit)}` : "r/reddit"),
    timestamp: timestamp(data.created_utc),
    permalink,
    ...(destinationUrl && destinationUrl !== permalink ? { destinationUrl } : {}),
    ...(previewFrom(data) ? { thumbnailUrl: previewFrom(data) } : {}),
    score: Math.trunc(numberValue(data.score)),
    commentCount: Math.max(0, Math.trunc(numberValue(data.num_comments))),
    ...(data.over_18 === true ? { isNsfw: true } : {}),
  };
}

function listingChildren(value: unknown): unknown[] {
  const listing = record(value);
  const data = record(listing?.data);
  return Array.isArray(data?.children) ? data.children : [];
}

export function flattenRedditComments(
  children: unknown[],
  maxDepth: number,
): { comments: RedditComment[]; truncated: boolean } {
  const comments: RedditComment[] = [];
  let truncated = false;

  const visit = (nodes: unknown[], depth: number) => {
    for (const node of nodes) {
      if (comments.length >= MAX_COMMENTS_PER_POST) {
        truncated = true;
        return;
      }
      const wrapper = record(node);
      if (text(wrapper?.kind) === "more") {
        const moreData = record(wrapper?.data);
        if (Array.isArray(moreData?.children) && moreData.children.length) truncated = true;
        continue;
      }
      if (text(wrapper?.kind) !== "t1") continue;
      const data = record(wrapper?.data);
      if (!data) continue;
      const id = text(data.id);
      if (!id) continue;
      if (depth <= maxDepth) {
        const permalink = absoluteRedditUrl(data.permalink);
        comments.push({
          id,
          author: text(data.author) || "deleted",
          text: text(data.body),
          timestamp: timestamp(data.created_utc),
          ...(permalink ? { permalink } : {}),
          ...(text(data.parent_id) ? { parentId: text(data.parent_id) } : {}),
          score: Math.trunc(numberValue(data.score)),
          depth,
        });
      }
      if (depth >= maxDepth) {
        const replies = record(data.replies);
        if (listingChildren(replies).length) truncated = true;
        continue;
      }
      const replies = record(data.replies);
      const replyChildren = listingChildren(replies);
      if (replyChildren.length) visit(replyChildren, depth + 1);
    }
  };

  visit(children, 0);
  return { comments, truncated };
}

function parseJson(textValue: string): unknown {
  const clean = textValue.trim().replace(/^\)\]\}',?\s*/, "");
  try {
    return JSON.parse(clean);
  } catch {
    const preview = clean.replace(/\s+/g, " ").slice(0, 700);
    throw new Error(`Reddit вернул страницу вместо JSON. Фрагмент ответа: ${preview || "пустой ответ"}`);
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
      "user-agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 220).replace(/\s+/g, " ")}`);
  return parseJson(body);
}

async function redditJson(pathAndQuery: string): Promise<unknown> {
  const errors: string[] = [];
  for (const origin of REDDIT_ORIGINS) {
    const url = `${origin}${pathAndQuery}`;
    try {
      return await fetchJson(url);
    } catch (error) {
      errors.push(`${origin}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(errors.join(" | "));
}

function isoTimestamp(value: unknown): string {
  const candidate = text(value);
  if (!candidate) return "";
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

export function normalizeRedditWebPost(value: unknown): RedditPost | null {
  const data = record(value);
  if (!data) return null;
  const permalink = absoluteRedditUrl(data.permalink);
  const id = text(data.id).replace(/^t3_/, "") || /\/comments\/([^/?#]+)/i.exec(permalink)?.[1] || "";
  if (!id || !permalink) return null;
  const destinationUrl = safeMediaUrl(data.destinationUrl);
  const thumbnailUrl = safeMediaUrl(data.thumbnailUrl);
  const subredditName = text(data.subreddit).replace(/^\/?r\//i, "");
  return {
    id,
    title: text(data.title) || "Публикация без заголовка",
    text: text(data.text),
    author: text(data.author).replace(/^u\//, "") || "deleted",
    subreddit: subredditName ? `r/${subredditName}` : "r/reddit",
    timestamp: isoTimestamp(data.timestamp),
    permalink,
    ...(destinationUrl && destinationUrl !== permalink ? { destinationUrl } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    score: Math.trunc(numberValue(data.score)),
    commentCount: Math.max(0, Math.trunc(numberValue(data.commentCount))),
    ...(data.isNsfw === true || text(data.isNsfw) === "true" ? { isNsfw: true } : {}),
  };
}

export function normalizeRedditWebComment(value: unknown): RedditComment | null {
  const data = record(value);
  if (!data) return null;
  const permalink = absoluteRedditUrl(data.permalink);
  const id = text(data.id).replace(/^t1_/, "") || /\/comment\/([^/?#]+)/i.exec(permalink)?.[1] || "";
  const body = text(data.text);
  if (!id || !body) return null;
  return {
    id,
    author: text(data.author).replace(/^u\//, "") || "deleted",
    text: body,
    timestamp: isoTimestamp(data.timestamp),
    ...(permalink ? { permalink } : {}),
    ...(text(data.parentId) ? { parentId: text(data.parentId).replace(/^t[13]_/, "") } : {}),
    score: Math.trunc(numberValue(data.score)),
    depth: Math.max(0, Math.trunc(numberValue(data.depth))),
  };
}

async function withRedditPage<T>(
  operation: (page: Page) => Promise<T>,
  proxySettings?: ReviewProxyCredentials,
  log?: RedditLogger,
): Promise<T> {
  let context: BrowserContext | undefined;
  let closeContext: (() => Promise<void>) | undefined;
  try {
    const created = await createContext(proxySettings);
    context = created.context;
    closeContext = created.close;
    log?.("proxy_context", "success", proxySettings?.server
      ? "Chromium Reddit запущен через сохранённую прокси отзывов."
      : "Chromium Reddit запущен с IP сервера.", {
      proxyEnabled: Boolean(proxySettings?.server),
      ...(created.browser.proxy ? { proxy: created.browser.proxy } : {}),
    });
    const page = await context.newPage();
    return await operation(page);
  } finally {
    if (closeContext) await closeContext().catch(() => undefined);
    else await context?.close().catch(() => undefined);
  }
}

async function gotoRedditPage(page: Page, url: string, log?: RedditLogger): Promise<void> {
  log?.("chromium_navigation", "started", "Открываем публичную страницу Reddit в Chromium.", { url });
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT_MS });
  await page.waitForTimeout(1_500);
  const state = await page.evaluate(() => ({
    title: document.title,
    text: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 700),
  }));
  if (/prove your humanity|recaptcha|security check|you've been blocked/i.test(`${state.title} ${state.text}`)) {
    log?.("chromium_navigation", "error", "Reddit показал проверку браузера.", {
      httpStatus: response?.status() ?? 0,
      finalUrl: page.url(),
      title: state.title,
      pagePreview: state.text,
    });
    throw new Error("Reddit запросил проверку браузера для IP сервера.");
  }
  if (response && response.status() >= 400) {
    log?.("chromium_navigation", "error", `Reddit вернул HTTP ${response.status()}.`, {
      httpStatus: response.status(),
      finalUrl: page.url(),
      title: state.title,
      pagePreview: state.text,
    });
    throw new Error(`HTTP ${response.status()}: ${state.text.slice(0, 220)}`);
  }
  log?.("chromium_navigation", "success", "Страница Reddit открыта.", {
    httpStatus: response?.status() ?? 0,
    finalUrl: page.url(),
    title: state.title,
  });
}

async function scrapeRedditWebPosts(page: Page): Promise<RedditPost[]> {
  const raw = await page.evaluate(() => {
    const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const count = (value: string | null | undefined) => {
      const candidate = clean(value).toLowerCase().replace(/\s+/g, "").replace(",", ".");
      const match = /(-?[\d.]+)\s*([kmb])?/.exec(candidate);
      if (!match) return 0;
      const multiplier = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : match[2] === "b" ? 1_000_000_000 : 1;
      return Math.round(Number(match[1]) * multiplier) || 0;
    };
    const result: Array<Record<string, string | number | boolean>> = [];
    const seen = new Set<string>();
    const candidates = [...document.querySelectorAll<HTMLElement>('shreddit-post, .thing.link, article, [data-testid="post-container"]')];
    for (const card of candidates) {
      const permalinkNode = card.querySelector<HTMLAnchorElement>('a[href*="/comments/"]');
      const permalink = card.getAttribute("permalink") || card.dataset.permalink || permalinkNode?.href || "";
      if (!permalink || seen.has(permalink)) continue;
      seen.add(permalink);
      const titleNode = card.querySelector<HTMLElement>('a[slot="title"], a.title, h1, h2, h3');
      const bodyNode = card.querySelector<HTMLElement>('[slot="text-body"], [slot="post-text"], .usertext-body .md, [data-testid="post-content"] p');
      const authorNode = card.querySelector<HTMLAnchorElement>('a[href*="/user/"], a[href*="/u/"]');
      const subredditNode = card.querySelector<HTMLAnchorElement>('a[href*="/r/"]');
      const timeNode = card.querySelector<HTMLTimeElement>("time");
      const imageNode = card.querySelector<HTMLImageElement>('img[slot="thumbnail"], img[alt="Post image"], img.preview, img.thumbnail');
      const commentsText = card.getAttribute("comment-count") || card.dataset.commentsCount || [...card.querySelectorAll<HTMLElement>("a,span")].map((node) => clean(node.textContent)).find((value) => /comments?|комментар/i.test(value)) || "";
      const scoreText = card.getAttribute("score") || card.dataset.score || card.querySelector<HTMLElement>('[slot="vote-button"], .score, [data-testid="post-vote-count"]')?.textContent || "";
      const destinationNode = [...card.querySelectorAll<HTMLAnchorElement>("a[href]")].find((link) => {
        try {
          const parsed = new URL(link.href, location.href);
          return !/(^|\.)reddit\.com$/i.test(parsed.hostname) && !parsed.hostname.endsWith(".redd.it");
        } catch { return false; }
      });
      result.push({
        id: card.getAttribute("id") || card.dataset.fullname || "",
        title: card.getAttribute("post-title") || clean(titleNode?.textContent),
        text: clean(bodyNode?.innerText || bodyNode?.textContent),
        author: card.getAttribute("author") || card.dataset.author || clean(authorNode?.textContent),
        subreddit: card.getAttribute("subreddit-prefixed-name") || card.dataset.subredditPrefixedName || card.dataset.subreddit || clean(subredditNode?.textContent),
        timestamp: card.getAttribute("created-timestamp") || card.dataset.timestamp || timeNode?.dateTime || "",
        permalink,
        destinationUrl: card.getAttribute("content-href") || card.dataset.url || destinationNode?.href || "",
        thumbnailUrl: card.getAttribute("thumbnail") || imageNode?.currentSrc || imageNode?.src || "",
        score: count(scoreText),
        commentCount: count(commentsText),
        isNsfw: card.getAttribute("over-18") === "true" || card.classList.contains("over18"),
      });
    }
    return result;
  });
  return raw.map(normalizeRedditWebPost).filter((post): post is RedditPost => Boolean(post));
}

async function searchRedditWithBrowser(
  request: RedditSearchRequest,
  log?: RedditLogger,
  proxySettings?: ReviewProxyCredentials,
): Promise<RedditPost[]> {
  return withRedditPage(async (page) => {
    const url = new URL("/search/", "https://www.reddit.com");
    url.searchParams.set("q", request.query);
    url.searchParams.set("type", "posts");
    url.searchParams.set("sort", "new");
    await gotoRedditPage(page, url.toString(), log);
    const posts = new Map<string, RedditPost>();
    let stagnantRounds = 0;
    for (let round = 0; round < 24 && posts.size < request.limit && stagnantRounds < 3; round += 1) {
      const before = posts.size;
      for (const post of await scrapeRedditWebPosts(page)) posts.set(post.id, post);
      log?.("chromium_scroll", "info", `Прочитана порция веб-выдачи Reddit №${round + 1}.`, {
        found: posts.size,
        requested: request.limit,
        stagnantRounds,
      });
      stagnantRounds = posts.size === before ? stagnantRounds + 1 : 0;
      if (posts.size >= request.limit || stagnantRounds >= 3) break;
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(1_400);
    }
    log?.("chromium_complete", "success", "Chromium завершил сбор постов Reddit.", { received: posts.size });
    return [...posts.values()].slice(0, request.limit);
  }, proxySettings, log);
}

async function scrapeRedditWebComments(page: Page, maxDepth: number): Promise<RedditComment[]> {
  const raw = await page.evaluate((depthLimit) => {
    const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const count = (value: string | null | undefined) => {
      const match = /(-?[\d.]+)/.exec(clean(value).replace(/\s+/g, "").replace(",", "."));
      return match ? Math.round(Number(match[1])) || 0 : 0;
    };
    const result: Array<Record<string, string | number>> = [];
    const seen = new Set<string>();
    const nodes = [...document.querySelectorAll<HTMLElement>('shreddit-comment, .thing.comment, [data-testid="comment"]')];
    for (const comment of nodes) {
      let oldRedditDepth = 0;
      let ancestor = comment.parentElement;
      while (ancestor) {
        if (ancestor.matches(".thing.comment")) oldRedditDepth += 1;
        ancestor = ancestor.parentElement;
      }
      const declaredDepth = comment.getAttribute("depth") || comment.dataset.depth;
      const depth = declaredDepth == null || declaredDepth === "" ? oldRedditDepth : Number(declaredDepth) || 0;
      if (depth > depthLimit) continue;
      const permalinkNode = comment.querySelector<HTMLAnchorElement>('a[href*="/comment/"], a.bylink, a[data-testid="comment_timestamp"]');
      const permalink = comment.getAttribute("permalink") || comment.dataset.permalink || permalinkNode?.href || "";
      const id = (comment.getAttribute("thingid") || comment.getAttribute("id") || comment.dataset.fullname || /\/comment\/([^/?#]+)/i.exec(permalink)?.[1] || "").replace(/^t1_/, "");
      if (!id || seen.has(id)) continue;
      const bodyNode = comment.querySelector<HTMLElement>('[slot="comment"], [slot="comment-body"], .usertext-body .md, [data-testid="comment"] p');
      const body = clean(bodyNode?.innerText || bodyNode?.textContent);
      if (!body) continue;
      seen.add(id);
      const authorNode = comment.querySelector<HTMLAnchorElement>('a[href*="/user/"], a.author');
      const timeNode = comment.querySelector<HTMLTimeElement>("time");
      result.push({
        id,
        author: comment.getAttribute("author") || comment.dataset.author || clean(authorNode?.textContent),
        text: body,
        timestamp: comment.getAttribute("created-timestamp") || comment.dataset.timestamp || timeNode?.dateTime || "",
        permalink,
        parentId: comment.getAttribute("parentid") || comment.dataset.parentId || "",
        score: count(comment.getAttribute("score") || comment.dataset.score || comment.querySelector<HTMLElement>(".score")?.textContent),
        depth,
      });
    }
    return result;
  }, maxDepth);
  return raw.map(normalizeRedditWebComment).filter((comment): comment is RedditComment => Boolean(comment));
}

async function fetchRedditConversationWithBrowser(
  selectedPost: RedditPost,
  maxDepth: number,
  log?: RedditLogger,
  proxySettings?: ReviewProxyCredentials,
): Promise<RedditConversationResponse> {
  return withRedditPage(async (page) => {
    await gotoRedditPage(page, selectedPost.permalink, log);
    const comments = new Map<string, RedditComment>();
    let stagnantRounds = 0;
    for (let round = 0; round < 12 && comments.size < MAX_COMMENTS_PER_POST && stagnantRounds < 3; round += 1) {
      const before = comments.size;
      for (const comment of await scrapeRedditWebComments(page, maxDepth)) comments.set(comment.id, comment);
      log?.("chromium_comments", "info", `Прочитана порция комментариев №${round + 1}.`, {
        received: comments.size,
        maxDepth,
      });
      stagnantRounds = comments.size === before ? stagnantRounds + 1 : 0;
      if (stagnantRounds >= 3) break;
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(1_200);
    }
    const values = [...comments.values()].slice(0, MAX_COMMENTS_PER_POST);
    log?.("chromium_complete", "success", "Chromium завершил сбор комментариев.", { received: values.length, maxDepth });
    return {
      post: selectedPost,
      comments: values,
      warnings: values.length >= MAX_COMMENTS_PER_POST ? ["В отчёт вошли первые 1000 загруженных комментариев."] : [],
      truncated: values.length >= MAX_COMMENTS_PER_POST,
      logs: [],
    };
  }, proxySettings, log);
}

function sourceUnavailable(jsonError: unknown, browserError: unknown, logs: RedditLogEntry[]): AppError {
  return new AppError(
    502,
    "REDDIT_SOURCE_UNAVAILABLE",
    "Reddit не отдал публичные данные серверу.",
    "Reddit мог заблокировать текущий IP VPS или сохранённой прокси. Проверьте прокси в Настройках либо повторите запрос позже.",
    {
      attempts: [
        `JSON: ${errorMessage(jsonError)}`,
        `Chromium: ${errorMessage(browserError)}`,
      ],
      logs,
    },
  );
}

export async function searchRedditPosts(
  request: RedditSearchRequest,
  onProgress?: (logs: RedditLogEntry[]) => void,
  proxySettings?: ReviewProxyCredentials,
): Promise<RedditSearchResponse> {
  const diagnostics = createRedditDiagnostics(onProgress);
  const { logs, log } = diagnostics;
  const params = new URLSearchParams({
    q: request.query,
    type: "link",
    sort: "new",
    t: "all",
    limit: String(request.limit),
    raw_json: "1",
    include_over_18: "on",
  });
  let posts: RedditPost[] = [];
  let source: RedditSearchResponse["source"] = "reddit-json";
  let jsonError: unknown;
  log("request", "started", "Запускаем поиск новых постов Reddit.", {
    query: request.query,
    limit: request.limit,
    sort: "new",
  });
  if (proxySettings?.server) {
    source = "chromium";
    log("proxy", "info", "Для Reddit используется сохранённая прокси из раздела отзывов; прямой запрос с IP VPS пропущен.");
    try {
      posts = await searchRedditWithBrowser(request, log, proxySettings);
      log("complete", "success", "Поиск Reddit через прокси завершён.", { source, received: posts.length });
      return {
        source,
        query: request.query,
        posts,
        warnings: posts.length ? [] : ["Reddit не нашёл публичных постов по этому запросу."],
        logs,
      };
    } catch (browserError) {
      log("fallback", "error", "Reddit не отдал выдачу Chromium через сохранённую прокси.", { reason: errorMessage(browserError) });
      throw sourceUnavailable(new Error("Прямой запрос пропущен: включена прокси."), browserError, logs);
    }
  }
  try {
    log("reddit_json", "started", "Запрашиваем структурированную выдачу Reddit.", { endpoints: REDDIT_ORIGINS.length });
    const data = await redditJson(`/search.json?${params.toString()}`);
    posts = listingChildren(data).map(normalizeRedditPost).filter((post): post is RedditPost => Boolean(post)).slice(0, request.limit);
    log("reddit_json", "success", "Структурированная выдача Reddit обработана.", { received: posts.length });
    if (!posts.length) {
      log("fallback", "info", "JSON-выдача пуста — проверяем публичную страницу через Chromium.");
      try {
        const browserPosts = await searchRedditWithBrowser(request, log);
        if (browserPosts.length) {
          posts = browserPosts;
          source = "chromium";
        }
      } catch (browserError) {
        log("fallback", "error", "Chromium не смог подтвердить пустую выдачу Reddit.", { reason: errorMessage(browserError) });
        // An empty structured result is still valid. A blocked HTML fallback must not turn it into a server error.
      }
    }
  } catch (error) {
    jsonError = error;
    log("reddit_json", "error", "Структурированная выдача Reddit недоступна или вернула HTML вместо JSON.", { reason: errorMessage(error) });
    source = "chromium";
    try {
      log("fallback", "started", "Переключаем поиск на Chromium.");
      posts = await searchRedditWithBrowser(request, log);
    } catch (browserError) {
      log("fallback", "error", "Chromium также не смог получить выдачу Reddit.", { reason: errorMessage(browserError) });
      throw sourceUnavailable(jsonError, browserError, logs);
    }
  }
  log("complete", "success", "Поиск Reddit завершён.", { source, received: posts.length });
  return {
    source,
    query: request.query,
    posts,
    warnings: posts.length ? [] : ["Reddit не нашёл публичных постов по этому запросу."],
    logs,
  };
}

export async function fetchRedditConversation(
  selectedPost: RedditPost,
  maxDepth: number,
  proxySettings?: ReviewProxyCredentials,
): Promise<RedditConversationResponse> {
  const diagnostics = createRedditDiagnostics();
  const { logs, log } = diagnostics;
  const params = new URLSearchParams({
    raw_json: "1",
    limit: "500",
    depth: String(maxDepth),
    sort: "top",
    showmore: "true",
  });
  let jsonError: unknown;
  log("request", "started", "Запускаем сбор комментариев к выбранному посту.", {
    postId: selectedPost.id,
    maxDepth,
    expectedComments: selectedPost.commentCount,
  });
  if (proxySettings?.server) {
    log("proxy", "info", "Комментарии Reddit собираются через сохранённую прокси отзывов; прямой запрос с IP VPS пропущен.");
    try {
      const browserResult = await fetchRedditConversationWithBrowser(selectedPost, maxDepth, log, proxySettings);
      log("complete", "success", "Сбор комментариев Reddit через прокси завершён.", { received: browserResult.comments.length });
      return { ...browserResult, logs };
    } catch (browserError) {
      log("fallback", "error", "Reddit не отдал комментарии Chromium через сохранённую прокси.", { reason: errorMessage(browserError) });
      throw sourceUnavailable(new Error("Прямой запрос пропущен: включена прокси."), browserError, logs);
    }
  }
  try {
    log("reddit_json", "started", "Запрашиваем дерево комментариев Reddit.", { postId: selectedPost.id });
    const data = await redditJson(`/comments/${encodeURIComponent(selectedPost.id)}.json?${params.toString()}`);
    const listings = Array.isArray(data) ? data : [];
    const post = normalizeRedditPost(listingChildren(listings[0])[0]) ?? selectedPost;
    const flattened = flattenRedditComments(listingChildren(listings[1]), maxDepth);
    const warnings: string[] = [];
    if (flattened.truncated) warnings.push("Reddit оставил часть большой ветки за блоками «ещё ответы» или лимитом выдачи.");
    log("reddit_json", "success", "Дерево комментариев Reddit обработано.", {
      received: flattened.comments.length,
      truncated: flattened.truncated,
    });
    if (!flattened.comments.length && selectedPost.commentCount > 0) {
      log("fallback", "info", "JSON не вернул ожидаемые комментарии — проверяем страницу через Chromium.");
      try {
        const browserResult = await fetchRedditConversationWithBrowser(selectedPost, maxDepth, log);
        if (browserResult.comments.length) return { ...browserResult, logs };
      } catch (browserError) {
        log("fallback", "error", "Chromium не смог получить отсутствующие комментарии.", { reason: errorMessage(browserError) });
        warnings.push("Reddit сообщил о комментариях, но не отдал их публичному серверному запросу.");
      }
    }
    log("complete", "success", "Сбор комментариев завершён.", { received: flattened.comments.length });
    return { post, comments: flattened.comments, warnings, truncated: flattened.truncated, logs };
  } catch (error) {
    jsonError = error;
    log("reddit_json", "error", "Структурированное дерево комментариев недоступно.", { reason: errorMessage(error) });
  }
  try {
    log("fallback", "started", "Переключаем сбор комментариев на Chromium.");
    const browserResult = await fetchRedditConversationWithBrowser(selectedPost, maxDepth, log);
    return { ...browserResult, logs };
  } catch (browserError) {
    log("fallback", "error", "Chromium также не смог получить комментарии Reddit.", { reason: errorMessage(browserError) });
    throw sourceUnavailable(jsonError, browserError, logs);
  }
}
