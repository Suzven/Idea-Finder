import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Request, Response } from "express";
import { AppError } from "../errors.js";

export interface MetaMedia {
  mediaType: "image" | "video";
  mediaUrl: string;
  thumbnailUrl: string;
  advertiserAvatar: string;
}

interface ExtractedMetaMedia {
  mediaType: "image" | "video";
  mediaUrl: string;
  thumbnailUrl?: string;
  advertiserAvatar?: string;
}

interface Candidate {
  kind: "image" | "video";
  url: string;
  score: number;
}

const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REGISTRATION_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 1_000;
const registeredAds = new Map<string, { url: string; expiresAt: number }>();
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

function targetAdSource(html: string, adId?: string): string {
  const source = decodeHtml(html);
  if (!adId) return source;
  const deeplinkIndex = source.indexOf('"deeplink_ad_archive_result"');
  const marker = `"ad_archive_id":"${adId}"`;
  const targetIndex = source.indexOf(marker, Math.max(0, deeplinkIndex));
  if (targetIndex < 0) return "";
  return source.slice(targetIndex, targetIndex + 500_000);
}

export function extractMetaMediaFromHtml(html: string, adId?: string): ExtractedMetaMedia | undefined {
  const source = targetAdSource(html, adId);
  if (!source) return undefined;
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (kind: Candidate["kind"], rawUrl: string, score: number, position = 0) => {
    const url = decodeUrl(rawUrl);
    if (!url || seen.has(`${kind}:${url}`)) return;
    seen.add(`${kind}:${url}`);
    const context = source.slice(Math.max(0, position - 250), position + 600);
    const smallAssetPenalty = /(?:emoji|profile|avatar|p\d+x\d+|s\d+x\d+)/i.test(url) ? 350 : 0;
    candidates.push({ kind, url, score: score + dimensionsScore(context) - smallAssetPenalty });
  };

  const avatarMatch = source.match(/["']page_profile_picture_url["']\s*:\s*["']((?:\\.|[^"'\\])*)["']/i);
  const advertiserAvatar = avatarMatch ? decodeUrl(avatarMatch[1]) : undefined;
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
    const rawUrl = attributes.match(/(?:src|data-src)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (rawUrl) add(kind, rawUrl, kind === "video" ? 850 : 500, match.index);
    if (kind === "video") {
      const poster = attributes.match(/poster\s*=\s*["']([^"']+)["']/i)?.[1];
      if (poster) add("image", poster, 850, match.index);
    }
  }

  const videos = candidates.filter((candidate) => candidate.kind === "video").sort((a, b) => b.score - a.score);
  const images = candidates.filter((candidate) => candidate.kind === "image").sort((a, b) => b.score - a.score);
  if (videos[0]) return { mediaType: "video", mediaUrl: videos[0].url, thumbnailUrl: images[0]?.url, ...(advertiserAvatar ? { advertiserAvatar } : {}) };
  if (images[0]) return { mediaType: "image", mediaUrl: images[0].url, thumbnailUrl: images[0].url, ...(advertiserAvatar ? { advertiserAvatar } : {}) };
  return undefined;
}

function pruneMaps(): void {
  const now = Date.now();
  for (const [id, entry] of registeredAds) if (entry.expiresAt <= now) registeredAds.delete(id);
  for (const [id, entry] of mediaCache) if (entry.expiresAt <= now) mediaCache.delete(id);
  while (registeredAds.size > MAX_ENTRIES) registeredAds.delete(registeredAds.keys().next().value as string);
  while (mediaCache.size > MAX_ENTRIES) mediaCache.delete(mediaCache.keys().next().value as string);
}

export function registerMetaAd(adId: string): string | undefined {
  if (!/^\d+$/.test(adId)) return undefined;
  const pageUrl = new URL("https://www.facebook.com/ads/library/");
  pageUrl.searchParams.set("id", adId);
  registeredAds.set(adId, { url: pageUrl.toString(), expiresAt: Date.now() + REGISTRATION_TTL_MS });
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
  try {
    const response = await fetch(registration.url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    const html = await readLimitedText(response);
    if (/session has expired|error validating access token|invalid oauth access token/i.test(html)) {
      throw new AppError(
        401,
        "META_TOKEN_EXPIRED",
        "Токен Meta истёк, был отозван или больше не действителен.",
        "Получите новый долгосрочный User Access Token, замените META_ACCESS_TOKEN в защищённом env-файле и перезапустите сервис.",
      );
    }
    if (!response.ok) throw new AppError(502, "META_AD_PAGE_FAILED", `Meta не отдала страницу объявления (HTTP ${response.status}).`);
    const media = extractMetaMediaFromHtml(html, adId);
    if (!media) throw new AppError(404, "META_MEDIA_NOT_FOUND", "На странице объявления не найдено доступное изображение или видео.");
    return media;
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
  };
}

export async function streamMetaMedia(adId: string, variant: "content" | "thumbnail" | "avatar", request: Request, response: Response): Promise<void> {
  const media = await resolveExtractedMetaMedia(adId);
  const remoteUrl = variant === "thumbnail" ? media.thumbnailUrl : variant === "avatar" ? media.advertiserAvatar : media.mediaUrl;
  if (!remoteUrl) throw new AppError(404, "META_MEDIA_VARIANT_NOT_FOUND", "Запрошенный вариант медиа недоступен.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(remoteUrl, {
      headers: {
        ...(request.header("range") ? { Range: request.header("range") as string } : {}),
        Referer: "https://www.facebook.com/",
        "User-Agent": request.header("user-agent") ?? "Mozilla/5.0",
      },
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  const expectedType = variant !== "content" || media.mediaType === "image" ? "image/" : "video/";
  if (!upstream.ok || !contentType.toLowerCase().startsWith(expectedType)) {
    throw new AppError(502, "META_MEDIA_FETCH_FAILED", `Медиафайл Meta временно недоступен (HTTP ${upstream.status}).`);
  }

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
