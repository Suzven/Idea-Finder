import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { existsSync } from "node:fs";
import type { Request, Response } from "express";
import { chromium, type Browser } from "playwright";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { IntegrationLogger } from "./integrationLogger.js";

export interface MetaMedia {
  mediaType: "image" | "video";
  mediaUrl: string;
  thumbnailUrl: string;
  advertiserAvatar: string;
  landingUrl?: string;
  cta?: string;
}

interface ExtractedMetaMedia {
  mediaType: "image" | "video";
  mediaUrl: string;
  thumbnailUrl?: string;
  advertiserAvatar?: string;
  landingUrl?: string;
  cta?: string;
}

interface Candidate {
  kind: "image" | "video";
  url: string;
  score: number;
}

export interface MetaMediaParseAttempt {
  stage: string;
  [key: string]: unknown;
}

const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const META_DEMO_AD_QUERY_NAME = "AdLibraryV3DemoAdContentQuery";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REGISTRATION_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 1_000;
const registeredAds = new Map<string, { snapshotUrl?: string; expiresAt: number }>();
const mediaCache = new Map<string, { value: Promise<ExtractedMetaMedia>; expiresAt: number }>();
const waiters: Array<() => void> = [];
let activeSnapshots = 0;
let browserPromise: Promise<Browser> | undefined;

function isMetaMediaHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ["fbcdn.net", "fbsbx.com", "cdninstagram.com"].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function decodeUrl(value: string): string | undefined {
  let decoded = decodeHtml(value.trim());
  try {
    decoded = JSON.parse(`"${decoded}"`) as string;
  } catch {
    decoded = decoded
      .replaceAll("\\/", "/")
      .replace(/\\u([0-9a-f]{4})/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
      .replaceAll("\\x3a", ":")
      .replaceAll("\\x2f", "/")
      .replaceAll("\\x26", "&");
  }
  for (let attempt = 0; attempt < 2 && /^https?%3a%2f%2f/i.test(decoded); attempt += 1) {
    try { decoded = decodeURIComponent(decoded); } catch { break; }
  }
  try {
    const parsed = new URL(decoded);
    if (parsed.protocol !== "https:" || !isMetaMediaHost(parsed.hostname)) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function fieldScore(field: string): number {
  const scores: Record<string, number> = {
    playable_url_quality_hd: 1_000,
    video_hd_url: 990,
    watermarked_video_hd_url: 980,
    playable_url: 950,
    video_sd_url: 940,
    watermarked_video_sd_url: 930,
    video_preview_image_url: 850,
    original_image_url: 800,
    resized_image_url: 760,
    image_url: 700,
    image_uri: 680,
    thumbnail_url: 600,
  };
  return scores[field] ?? 100;
}

function dimensionsScore(context: string): number {
  const width = Number(context.match(/["'](?:width|original_width)["']\s*:\s*["']?(\d+)/i)?.[1] ?? 0);
  const height = Number(context.match(/["'](?:height|original_height)["']\s*:\s*["']?(\d+)/i)?.[1] ?? 0);
  if (!width || !height) return 0;
  if (width <= 80 || height <= 80) return -500;
  return Math.min(180, Math.round(Math.log2(width * height) * 8));
}

function smallAssetPenalty(url: string): number {
  if (/(?:emoji|profile|avatar)/i.test(url)) return 350;
  const dimensions = url.match(/(?:^|[_?&])(?:p|s|dst-jpg_s)(\d+)x(\d+)/i);
  if (!dimensions) return 0;
  return Number(dimensions[1]) <= 160 || Number(dimensions[2]) <= 160 ? 350 : 0;
}

function attributeValue(attributes: string, name: string): string | undefined {
  return attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
}

function decodeLandingUrl(rawValue: string): string | undefined {
  const decoded = decodeHtml(rawValue.trim()).replaceAll("\\/", "/");
  try {
    const parsed = new URL(decoded);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    if (["l.facebook.com", "lm.facebook.com"].includes(parsed.hostname.toLowerCase()) && parsed.pathname === "/l.php") {
      const destination = parsed.searchParams.get("u");
      if (!destination) return undefined;
      const unwrapped = new URL(destination);
      return ["https:", "http:"].includes(unwrapped.protocol) ? unwrapped.toString() : undefined;
    }
    const host = parsed.hostname.toLowerCase();
    if (host === "facebook.com" || host.endsWith(".facebook.com") || isMetaMediaHost(host) || host.endsWith(".fbcdn.net")) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function extractLandingUrl(source: string, diagnostics: MetaMediaParseAttempt[]): string | undefined {
  const candidates: Array<{ url: string; score: number; attribute: string }> = [];
  for (const match of source.matchAll(/<a\b([^>]*)>/gi)) {
    const attributes = match[1];
    for (const attribute of ["data-lynx-uri", "href"] as const) {
      const rawUrl = attributeValue(attributes, attribute);
      if (!rawUrl) continue;
      const url = decodeLandingUrl(rawUrl);
      if (!url) continue;
      const isLinkShim = /https?:\/\/(?:l|lm)\.facebook\.com\/l\.php/i.test(rawUrl);
      candidates.push({ url, score: (attribute === "data-lynx-uri" ? 1_100 : 1_000) + (isLinkShim ? 100 : 0), attribute });
    }
  }
  for (const match of source.matchAll(/["']link_url["']\s*:\s*["']((?:\\.|[^"'\\])*)["']/gi)) {
    const url = decodeLandingUrl(match[1]);
    if (url) candidates.push({ url, score: 950, attribute: "link_url" });
  }
  candidates.sort((a, b) => b.score - a.score);
  diagnostics.push({ stage: "landing_url", candidates: candidates.length, selected: candidates[0] ?? null });
  return candidates[0]?.url;
}

const CTA_LABELS: Record<string, string> = {
  APPLY_NOW: "Подать заявку",
  BOOK_NOW: "Забронировать",
  BUY_NOW: "Купить",
  CONTACT_US: "Связаться",
  DOWNLOAD: "Скачать",
  GET_OFFER: "Получить предложение",
  GET_QUOTE: "Узнать цену",
  LEARN_MORE: "Подробнее",
  LISTEN_NOW: "Слушать",
  ORDER_NOW: "Заказать",
  PLAY_GAME: "Играть",
  SEE_MENU: "Посмотреть меню",
  SHOP_NOW: "В магазин",
  SIGN_UP: "Зарегистрироваться",
  SUBSCRIBE: "Подписаться",
  WATCH_MORE: "Смотреть",
};

function normalizeCtaText(rawValue: string, mapEnum = false): string | undefined {
  let value = decodeHtml(rawValue)
    .replace(/<[^>]*>/g, " ")
    .replace(/\\u([0-9a-f]{4})/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replaceAll("\\/", "/")
    .replace(/\s+/g, " ")
    .trim();
  try { value = JSON.parse(`"${value}"`) as string; } catch { /* already decoded */ }
  if (!value || value.length > 80 || /^https?:\/\//i.test(value)) return undefined;
  const enumValue = value.toUpperCase().replace(/[\s-]+/g, "_");
  return mapEnum ? CTA_LABELS[enumValue] ?? value : value;
}

function extractCtaText(source: string, landingUrl: string | undefined, diagnostics: MetaMediaParseAttempt[]): string | undefined {
  const candidates: Array<{ text: string; score: number; source: string }> = [];
  const add = (rawText: string | undefined, score: number, candidateSource: string, mapEnum = false) => {
    if (!rawText) return;
    const text = normalizeCtaText(rawText, mapEnum);
    if (text) candidates.push({ text, score, source: candidateSource });
  };

  const jsonFields: Array<[string, number]> = [
    ["cta_text", 1_600],
    ["call_to_action_text", 1_550],
    ["call_to_action_type", 900],
    ["cta_type", 850],
  ];
  for (const [field, score] of jsonFields) {
    const pattern = new RegExp(`["']${field}["']\\s*:\\s*["']((?:\\\\.|[^"'\\\\])*)["']`, "gi");
    for (const match of source.matchAll(pattern)) add(match[1], score, field, field.endsWith("type"));
  }

  for (const match of source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attributes = match[1];
    const rawUrl = attributeValue(attributes, "data-lynx-uri") ?? attributeValue(attributes, "href");
    const url = rawUrl ? decodeLandingUrl(rawUrl) : undefined;
    const sameLanding = Boolean(url && landingUrl && url === landingUrl);
    add(attributeValue(attributes, "aria-label"), sameLanding ? 1_350 : 850, "anchor_aria_label");
    add(match[2], sameLanding ? 1_250 : 650, "anchor_text");
  }

  for (const match of source.matchAll(/<(button|div)\b([^>]*(?:role\s*=\s*["']button["']|aria-label\s*=\s*["'][^"']+["'])[^>]*)>([\s\S]*?)<\/\1>/gi)) {
    add(attributeValue(match[2], "aria-label"), 1_100, "button_aria_label");
    add(match[3], 1_000, "button_text");
  }

  candidates.sort((a, b) => b.score - a.score);
  diagnostics.push({ stage: "cta_text", candidates: candidates.length, selected: candidates[0] ?? null });
  return candidates[0]?.text;
}

function targetAdSource(html: string, adId?: string): string {
  const source = decodeHtml(html);
  if (!adId) return source;
  const renderedIdPatterns = [
    new RegExp(`ID\\s+Библиотеки:\\s*${adId}(?:\\D|$)`, "i"),
    new RegExp(`["']entity_id["']\\s*:\\s*["']${adId}["']`, "i"),
  ];
  if (renderedIdPatterns.some((pattern) => pattern.test(source))) return source;
  const deeplinkIndex = source.indexOf('"deeplink_ad_archive_result"');
  const marker = `"ad_archive_id":"${adId}"`;
  const targetIndex = source.indexOf(marker, Math.max(0, deeplinkIndex));
  if (targetIndex < 0) return "";
  return source.slice(targetIndex, targetIndex + 500_000);
}

export function extractMetaMediaFromHtml(
  html: string,
  adId?: string,
  diagnostics: MetaMediaParseAttempt[] = [],
): ExtractedMetaMedia | undefined {
  const source = targetAdSource(html, adId);
  diagnostics.push({
    stage: "target_ad",
    adId: adId ?? null,
    htmlLength: html.length,
    targetFound: Boolean(source),
    targetLength: source.length,
  });
  if (!source) return undefined;
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (kind: Candidate["kind"], rawUrl: string, score: number, position = 0) => {
    const url = decodeUrl(rawUrl);
    if (!url) {
      diagnostics.push({ stage: "candidate_rejected", kind, reason: "invalid_or_non_meta_url", rawUrl });
      return;
    }
    if (seen.has(`${kind}:${url}`)) {
      diagnostics.push({ stage: "candidate_rejected", kind, reason: "duplicate", url });
      return;
    }
    seen.add(`${kind}:${url}`);
    const context = source.slice(Math.max(0, position - 250), position + 600);
    const assetPenalty = smallAssetPenalty(url);
    const dimensionBonus = dimensionsScore(context);
    const finalScore = score + dimensionBonus - assetPenalty;
    candidates.push({ kind, url, score: finalScore });
    diagnostics.push({ stage: "candidate_accepted", kind, url, baseScore: score, dimensionBonus, smallAssetPenalty: assetPenalty, finalScore });
  };

  const avatarMatch = source.match(/["']page_profile_picture_url["']\s*:\s*["']((?:\\.|[^"'\\])*)["']/i);
  let advertiserAvatar = avatarMatch ? decodeUrl(avatarMatch[1]) : undefined;
  const landingUrl = extractLandingUrl(source, diagnostics);
  const cta = extractCtaText(source, landingUrl, diagnostics);
  const fieldPattern = /["'](playable_url_quality_hd|playable_url|video_hd_url|video_sd_url|watermarked_video_hd_url|watermarked_video_sd_url|video_preview_image_url|original_image_url|resized_image_url|image_url|image_uri|thumbnail_url)["']\s*:\s*["']((?:\\.|[^"'\\])*)["']/gi;
  for (const match of source.matchAll(fieldPattern)) {
    const field = match[1].toLowerCase();
    const kind = field === "video_preview_image_url" ? "image" : field.includes("video") || field.includes("playable") ? "video" : "image";
    add(kind, match[2], fieldScore(field), match.index);
  }

  const tagPattern = /<(video|source|img)\b([^>]*)>/gi;
  for (const match of source.matchAll(tagPattern)) {
    const kind = match[1].toLowerCase() === "img" ? "image" : "video";
    const attributes = match[2];
    const rawUrl = attributeValue(attributes, "src") ?? attributeValue(attributes, "data-src");
    const alt = decodeHtml(attributeValue(attributes, "alt") ?? "").trim();
    const className = attributeValue(attributes, "class") ?? "";
    const isAvatar = kind === "image" && Boolean(rawUrl) && (
      /(?:^|\s)_8nqq(?:\s|$)/.test(className)
      || (Boolean(alt) && /(?:s|p|dst-jpg_s)\d{2,3}x\d{2,3}/i.test(rawUrl ?? ""))
    );
    if (isAvatar && rawUrl) {
      advertiserAvatar = decodeUrl(rawUrl) ?? advertiserAvatar;
      diagnostics.push({ stage: "rendered_avatar", alt, url: advertiserAvatar ?? null, matchedBy: /_8nqq/.test(className) ? "class" : "alt_and_size" });
    } else if (rawUrl) {
      add(kind, rawUrl, kind === "video" ? 1_200 : 1_100, match.index);
    }
    if (kind === "video") {
      const poster = attributeValue(attributes, "poster");
      if (poster) add("image", poster, 1_150, match.index);
    }
  }

  const videos = candidates.filter((candidate) => candidate.kind === "video").sort((a, b) => b.score - a.score);
  const images = candidates.filter((candidate) => candidate.kind === "image").sort((a, b) => b.score - a.score);
  diagnostics.push({
    stage: "candidate_selection",
    videoCandidates: videos.length,
    imageCandidates: images.length,
    selectedVideo: videos[0] ?? null,
    selectedImage: images[0] ?? null,
    advertiserAvatar: advertiserAvatar ?? null,
    landingUrl: landingUrl ?? null,
    cta: cta ?? null,
  });
  const optionalFields = { ...(advertiserAvatar ? { advertiserAvatar } : {}), ...(landingUrl ? { landingUrl } : {}), ...(cta ? { cta } : {}) };
  if (videos[0]) return { mediaType: "video", mediaUrl: videos[0].url, thumbnailUrl: images[0]?.url, ...optionalFields };
  if (images[0]) return { mediaType: "image", mediaUrl: images[0].url, thumbnailUrl: images[0].url, ...optionalFields };
  return undefined;
}

function pruneMaps(): void {
  const now = Date.now();
  for (const [id, entry] of registeredAds) if (entry.expiresAt <= now) registeredAds.delete(id);
  for (const [id, entry] of mediaCache) if (entry.expiresAt <= now) mediaCache.delete(id);
  while (registeredAds.size > MAX_ENTRIES) registeredAds.delete(registeredAds.keys().next().value as string);
  while (mediaCache.size > MAX_ENTRIES) mediaCache.delete(mediaCache.keys().next().value as string);
}

function validateSnapshotUrl(adId: string, snapshotUrl: string | undefined): string | undefined {
  if (!snapshotUrl) return undefined;
  try {
    const parsed = new URL(snapshotUrl);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || (host !== "facebook.com" && !host.endsWith(".facebook.com"))) return undefined;
    if (!/^\/ads\/archive\/render_ad\/?$/i.test(parsed.pathname) || parsed.searchParams.get("id") !== adId) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function registerMetaAd(adId: string, snapshotUrl?: string): string | undefined {
  if (!/^\d+$/.test(adId)) return undefined;
  const validatedSnapshotUrl = validateSnapshotUrl(adId, snapshotUrl);
  registeredAds.set(adId, { snapshotUrl: validatedSnapshotUrl, expiresAt: Date.now() + REGISTRATION_TTL_MS });
  pruneMaps();
  return `/api/meta/media/${encodeURIComponent(adId)}`;
}

async function acquireSnapshotSlot(): Promise<void> {
  if (activeSnapshots < 3) {
    activeSnapshots += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  activeSnapshots += 1;
}

function releaseSnapshotSlot(): void {
  activeSnapshots -= 1;
  waiters.shift()?.();
}

export function getMetaChromiumExecutablePath(): string {
  const executablePath = [
    config.metaChromiumExecutablePath,
    chromium.executablePath(),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (!executablePath) {
    throw new AppError(
      503,
      "META_CHROMIUM_NOT_INSTALLED",
      "Для загрузки креативов Meta не найден Chromium.",
      "Выполните `pnpm exec playwright install chromium` или задайте META_CHROMIUM_EXECUTABLE_PATH.",
    );
  }
  return executablePath;
}

export async function getMetaBrowser(): Promise<Browser> {
  if (browserPromise) return browserPromise;
  const executablePath = getMetaChromiumExecutablePath();
  browserPromise = chromium.launch({ headless: true, executablePath }).then((browser) => {
    browser.once("disconnected", () => { browserPromise = undefined; });
    return browser;
  }).catch((error) => {
    browserPromise = undefined;
    throw error;
  });
  return browserPromise;
}

async function scrapeMetaMedia(adId: string): Promise<ExtractedMetaMedia> {
  const registration = registeredAds.get(adId);
  if (!registration || registration.expiresAt <= Date.now()) {
    registeredAds.delete(adId);
    throw new AppError(404, "META_AD_NOT_REGISTERED", "Объявление больше не зарегистрировано. Запустите поиск ещё раз.");
  }
  if (!registration.snapshotUrl) {
    throw new AppError(404, "META_SNAPSHOT_URL_MISSING", "Meta не вернула ad_snapshot_url для этого объявления.");
  }

  await acquireSnapshotSlot();
  const pageLogger = await IntegrationLogger.start({
    provider: "meta",
    operation: "ad_snapshot_browser_page",
    method: "GET",
    url: registration.snapshotUrl,
    body: { adId },
  });
  let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
  let pageStatus: number | undefined;
  let pageHeaders: Record<string, string> | undefined;
  let pageHtml: string | undefined;
  let pageLogFinished = false;
  let graphqlLogger: IntegrationLogger | undefined;
  let graphqlStatus: number | undefined;
  let graphqlHeaders: Record<string, string> | undefined;
  let graphqlBody: string | undefined;
  const parseAttempts: MetaMediaParseAttempt[] = [{ stage: "browser_snapshot_start", adId }];
  try {
    const browser = await getMetaBrowser();
    context = await browser.newContext({ locale: "ru-RU" });
    const page = await context.newPage();
    const graphqlResponsePromise = page.waitForResponse((response) => {
      const requestBody = response.request().postData() ?? "";
      return response.url().includes("/api/graphql/")
        && requestBody.includes(META_DEMO_AD_QUERY_NAME)
        && requestBody.includes(adId);
    }, { timeout: 30_000 });
    const [pageResponse, graphqlResponse] = await Promise.all([
      page.goto(registration.snapshotUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }),
      graphqlResponsePromise,
    ]);
    if (!pageResponse) throw new AppError(502, "META_AD_PAGE_FAILED", "Chromium не получил ответ страницы Meta.");
    pageStatus = pageResponse.status();
    pageHeaders = pageResponse.headers();
    pageHtml = await page.content();
    parseAttempts.push({ stage: "browser_snapshot_response", status: pageStatus, bodyLength: pageHtml.length });
    if (!pageResponse.ok()) throw new AppError(502, "META_AD_PAGE_FAILED", `Meta не отдала snapshot-страницу (HTTP ${pageStatus}).`);
    await pageLogger.success({ responseStatus: pageStatus, responseHeaders: pageHeaders, responseBody: pageHtml, parseAttempts });
    pageLogFinished = true;

    const graphqlRequest = graphqlResponse.request();
    graphqlStatus = graphqlResponse.status();
    graphqlHeaders = graphqlResponse.headers();
    graphqlBody = await graphqlResponse.text();
    if (Buffer.byteLength(graphqlBody) > MAX_PAGE_BYTES) {
      throw new AppError(502, "META_PAGE_TOO_LARGE", "GraphQL-ответ Meta слишком большой для обработки.");
    }
    graphqlLogger = await IntegrationLogger.start({
      provider: "meta",
      operation: "ad_snapshot_graphql_content",
      method: graphqlRequest.method(),
      url: graphqlRequest.url(),
      headers: await graphqlRequest.allHeaders(),
      body: graphqlRequest.postData(),
    });
    parseAttempts.push({ stage: "browser_graphql_response", status: graphqlStatus, bodyLength: graphqlBody.length });
    const graphqlMedia = extractMetaMediaFromHtml(graphqlBody, adId, parseAttempts);
    const renderedMedia = pageHtml ? extractMetaMediaFromHtml(pageHtml, adId, parseAttempts) : undefined;
    const baseMedia = graphqlMedia ?? renderedMedia;
    if (!baseMedia) throw new AppError(404, "META_MEDIA_NOT_FOUND", "Страница объявления Meta не содержит изображения или видео.");
    const media: ExtractedMetaMedia = {
      ...baseMedia,
      advertiserAvatar: graphqlMedia?.advertiserAvatar ?? renderedMedia?.advertiserAvatar,
      landingUrl: graphqlMedia?.landingUrl ?? renderedMedia?.landingUrl,
      cta: renderedMedia?.cta ?? graphqlMedia?.cta,
    };
    await graphqlLogger.success({ responseStatus: graphqlStatus, responseHeaders: graphqlHeaders, responseBody: graphqlBody, parseAttempts });
    return media;
  } catch (error) {
    if (!pageLogFinished) {
      await pageLogger.error(error, { responseStatus: pageStatus, responseHeaders: pageHeaders, responseBody: pageHtml, parseAttempts });
    }
    if (graphqlLogger) {
      await graphqlLogger.error(error, { responseStatus: graphqlStatus, responseHeaders: graphqlHeaders, responseBody: graphqlBody, parseAttempts });
    }
    throw error;
  } finally {
    await context?.close().catch(() => undefined);
    releaseSnapshotSlot();
  }
}

async function resolveExtractedMetaMedia(adId: string): Promise<ExtractedMetaMedia> {
  if (!/^\d+$/.test(adId)) throw new AppError(400, "INVALID_META_AD_ID", "Некорректный ID объявления Meta.");
  const cached = mediaCache.get(adId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = scrapeMetaMedia(adId);
  mediaCache.set(adId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  try {
    return await value;
  } catch (error) {
    mediaCache.delete(adId);
    throw error;
  }
}

export async function getMetaMedia(adId: string): Promise<MetaMedia> {
  const media = await resolveExtractedMetaMedia(adId);
  return {
    mediaType: media.mediaType,
    mediaUrl: `/api/meta/media/${encodeURIComponent(adId)}/content`,
    thumbnailUrl: media.thumbnailUrl ? `/api/meta/media/${encodeURIComponent(adId)}/thumbnail` : "",
    advertiserAvatar: media.advertiserAvatar ? `/api/meta/media/${encodeURIComponent(adId)}/avatar` : "",
    ...(media.landingUrl ? { landingUrl: media.landingUrl } : {}),
    ...(media.cta ? { cta: media.cta } : {}),
  };
}

export async function streamMetaMedia(adId: string, variant: "content" | "thumbnail" | "avatar", request: Request, response: Response): Promise<void> {
  const media = await resolveExtractedMetaMedia(adId);
  const remoteUrl = variant === "thumbnail" ? media.thumbnailUrl : variant === "avatar" ? media.advertiserAvatar : media.mediaUrl;
  if (!remoteUrl) throw new AppError(404, "META_MEDIA_VARIANT_NOT_FOUND", "Запрошенный вариант медиа недоступен.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let upstream: globalThis.Response;
  const requestHeaders = {
    ...(request.header("range") ? { Range: request.header("range") as string } : {}),
    Referer: "https://www.facebook.com/",
    "User-Agent": request.header("user-agent") ?? "Mozilla/5.0",
  };
  const logger = await IntegrationLogger.start({
    provider: "meta",
    operation: `preview_media_${variant}`,
    method: "GET",
    url: remoteUrl,
    headers: requestHeaders,
  });
  try {
    upstream = await fetch(remoteUrl, {
      headers: requestHeaders,
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error) {
    await logger.error(error);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  const expectedType = variant !== "content" || media.mediaType === "image" ? "image/" : "video/";
  if (!upstream.ok || !contentType.toLowerCase().startsWith(expectedType)) {
    const error = new AppError(502, "META_MEDIA_FETCH_FAILED", `Медиафайл Meta временно недоступен (HTTP ${upstream.status}).`);
    await logger.error(error, {
      responseStatus: upstream.status,
      responseHeaders: upstream.headers,
      responseBody: { streamed: false, contentType, expectedType },
      parseAttempts: [{ stage: "validate_media_response", contentType, expectedType, valid: false }],
    });
    throw error;
  }

  await logger.success({
    responseStatus: upstream.status,
    responseHeaders: upstream.headers,
    responseBody: {
      streamed: true,
      contentType,
      contentLength: upstream.headers.get("content-length"),
      note: "Бинарное тело передано клиенту потоком и намеренно не копируется в БД.",
    },
    parseAttempts: [{ stage: "validate_media_response", contentType, expectedType, valid: true }],
  });

  response.status(upstream.status);
  for (const header of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(header);
    if (value) response.setHeader(header, value);
  }
  response.setHeader("Cache-Control", "private, max-age=3600");
  if (!upstream.body) {
    response.end();
    return;
  }
  const body = Readable.fromWeb(upstream.body as unknown as NodeReadableStream<Uint8Array>);
  response.on("close", () => { if (!response.writableEnded) body.destroy(); });
  body.on("error", (error) => response.destroy(error));
  body.pipe(response);
}
