import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Request, Response } from "express";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { IntegrationLogger } from "./integrationLogger.js";

export interface MetaMedia {
  mediaType: "image" | "video";
  mediaUrl: string;
  thumbnailUrl: string;
  advertiserAvatar: string;
  landingUrl?: string;
}

interface ExtractedMetaMedia {
  mediaType: "image" | "video";
  mediaUrl: string;
  thumbnailUrl?: string;
  advertiserAvatar?: string;
  landingUrl?: string;
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
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REGISTRATION_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 1_000;
const registeredAds = new Map<string, { snapshotUrl?: string; expiresAt: number }>();
const mediaCache = new Map<string, { value: Promise<ExtractedMetaMedia>; expiresAt: number }>();
const waiters: Array<() => void> = [];
let activeSnapshots = 0;

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
  candidates.sort((a, b) => b.score - a.score);
  diagnostics.push({ stage: "landing_url", candidates: candidates.length, selected: candidates[0] ?? null });
  return candidates[0]?.url;
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
  });
  const optionalFields = { ...(advertiserAvatar ? { advertiserAvatar } : {}), ...(landingUrl ? { landingUrl } : {}) };
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

interface SnapshotRequestCandidate {
  strategy: "ad_snapshot_url" | "ad_snapshot_url_noscript" | "current_token_noscript" | "public_ad_library";
  url: string;
}

export function buildMetaSnapshotRequestCandidates(
  adId: string,
  snapshotUrl?: string,
  accessToken = config.metaAccessToken,
): SnapshotRequestCandidate[] {
  const candidates: SnapshotRequestCandidate[] = [];
  const seen = new Set<string>();
  const add = (strategy: SnapshotRequestCandidate["strategy"], url: URL) => {
    const value = url.toString();
    if (seen.has(value)) return;
    seen.add(value);
    candidates.push({ strategy, url: value });
  };

  const validatedSnapshotUrl = validateSnapshotUrl(adId, snapshotUrl);
  if (validatedSnapshotUrl) {
    const snapshot = new URL(validatedSnapshotUrl);
    add("ad_snapshot_url", snapshot);
    const noScriptSnapshot = new URL(snapshot);
    noScriptSnapshot.searchParams.set("_fb_noscript", "1");
    add("ad_snapshot_url_noscript", noScriptSnapshot);
  }

  if (accessToken && (!validatedSnapshotUrl || new URL(validatedSnapshotUrl).searchParams.get("access_token") !== accessToken)) {
    const currentTokenSnapshot = new URL("https://www.facebook.com/ads/archive/render_ad/");
    currentTokenSnapshot.searchParams.set("id", adId);
    currentTokenSnapshot.searchParams.set("access_token", accessToken);
    currentTokenSnapshot.searchParams.set("_fb_noscript", "1");
    add("current_token_noscript", currentTokenSnapshot);
  }

  const publicPage = new URL("https://www.facebook.com/ads/library/");
  publicPage.searchParams.set("id", adId);
  add("public_ad_library", publicPage);
  return candidates;
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

async function readLimitedText(response: globalThis.Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_PAGE_BYTES) throw new AppError(502, "META_PAGE_TOO_LARGE", "Страница Meta слишком большая для обработки.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PAGE_BYTES) {
      await reader.cancel();
      throw new AppError(502, "META_PAGE_TOO_LARGE", "Страница Meta слишком большая для обработки.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}

async function scrapeMetaMedia(adId: string): Promise<ExtractedMetaMedia> {
  const registration = registeredAds.get(adId);
  if (!registration || registration.expiresAt <= Date.now()) {
    registeredAds.delete(adId);
    throw new AppError(404, "META_AD_NOT_REGISTERED", "Объявление больше не зарегистрировано. Запустите поиск ещё раз.");
  }

  await acquireSnapshotSlot();
  const requestHeaders = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Referer: "https://www.facebook.com/ads/library/",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  };
  const candidates = buildMetaSnapshotRequestCandidates(adId, registration.snapshotUrl);
  let lastError: unknown;
  let tokenError: AppError | undefined;
  try {
    for (const [index, candidate] of candidates.entries()) {
      const logger = await IntegrationLogger.start({
        provider: "meta",
        operation: "ad_library_preview_page",
        method: "GET",
        url: candidate.url,
        headers: requestHeaders,
        body: { adId, attempt: index + 1, totalAttempts: candidates.length, strategy: candidate.strategy },
      });
      let response: globalThis.Response | undefined;
      let html: string | undefined;
      const parseAttempts: MetaMediaParseAttempt[] = [{
        stage: "snapshot_request",
        attempt: index + 1,
        totalAttempts: candidates.length,
        strategy: candidate.strategy,
      }];
      try {
        response = await fetch(candidate.url, {
          headers: requestHeaders,
          redirect: "follow",
          signal: AbortSignal.timeout(12_000),
        });
        html = await readLimitedText(response);
        parseAttempts.push({
          stage: "snapshot_response",
          status: response.status,
          contentType: response.headers.get("content-type"),
          proxyStatus: response.headers.get("proxy-status"),
          finalUrl: response.url,
          bodyLength: html.length,
        });
        if (/session has expired|error validating access token|invalid oauth access token/i.test(html)) {
          throw new AppError(
            401,
            "META_TOKEN_EXPIRED",
            "Токен Meta истёк, был отозван или больше не действителен.",
            "Получите новый долгосрочный User Access Token, замените META_ACCESS_TOKEN в защищённом env-файле и перезапустите сервис.",
          );
        }
        if (!response.ok) throw new AppError(502, "META_AD_PAGE_FAILED", `Meta не отдала страницу объявления (HTTP ${response.status}, попытка: ${candidate.strategy}).`);
        const media = extractMetaMediaFromHtml(html, adId, parseAttempts);
        if (!media) throw new AppError(404, "META_MEDIA_NOT_FOUND", `В ответе Meta не найдено изображение или видео (попытка: ${candidate.strategy}).`);
        await logger.success({
          responseStatus: response.status,
          responseHeaders: response.headers,
          responseBody: html,
          parseAttempts,
        });
        return media;
      } catch (error) {
        lastError = error;
        if (error instanceof AppError && error.code === "META_TOKEN_EXPIRED") tokenError = error;
        parseAttempts.push({
          stage: "snapshot_attempt_failed",
          strategy: candidate.strategy,
          willRetry: index < candidates.length - 1,
          error: error instanceof Error ? error.message : String(error),
        });
        await logger.error(error, {
          responseStatus: response?.status,
          responseHeaders: response?.headers,
          responseBody: html,
          parseAttempts,
        });
      }
    }
    if (tokenError) throw tokenError;
    if (lastError instanceof AppError && lastError.code === "META_MEDIA_NOT_FOUND") throw lastError;
    throw new AppError(
      502,
      "META_AD_PAGE_FAILED",
      "Meta не отдала страницу объявления ни одним из доступных способов.",
      "Откройте Логи → Meta и проверьте отдельные попытки ad_snapshot_url, no-script и public_ad_library.",
    );
  } finally {
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
