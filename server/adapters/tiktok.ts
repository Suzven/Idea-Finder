import type { AdCreative, AdFilters, AdsResponse } from "../../src/shared/types.js";
import { config } from "../config.js";
import { filterAds } from "../services/filterAds.js";
import { IntegrationLogger } from "../services/integrationLogger.js";

interface TikTokAdDto {
  ad?: {
    id?: string | number;
    first_shown_date?: string;
    last_shown_date?: string;
    status?: string;
    videos?: Array<{ url?: string }>;
    image_urls?: string[];
    reach?: { unique_users_seen?: string };
  };
  advertiser?: { business_id?: string | number; business_name?: string; paid_for_by?: string; paid_by?: string };
}

interface TikTokResponse {
  data?: { ads?: TikTokAdDto[]; has_more?: boolean; search_id?: string };
  error?: { code?: string; message?: string };
}

function dateForApi(value: string | undefined, fallbackDays: number): string {
  const date = value ? new Date(`${value}T00:00:00Z`) : new Date(Date.now() - fallbackDays * 86_400_000);
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function parseReach(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^([\d.]+)([KMB])?$/i);
  if (!match) return undefined;
  const multiplier = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[match[2]?.toUpperCase() as "K" | "M" | "B"] ?? 1;
  return Math.round(Number(match[1]) * multiplier);
}

export async function fetchTikTokAds(filters: Partial<AdFilters>, cursor: string | undefined, limit: number): Promise<AdsResponse> {
  if (!config.tiktokAccessToken) throw new Error("TIKTOK_ACCESS_TOKEN не настроен");
  const selectedCountry = filters.country?.find((country) => country !== "ALL");
  const fields = [
    "ad.id", "ad.first_shown_date", "ad.last_shown_date", "ad.status", "ad.videos",
    "ad.image_urls", "ad.reach", "advertiser.business_id", "advertiser.business_name", "advertiser.paid_for_by",
  ].join(",");
  const body: Record<string, unknown> = {
    filters: {
      ad_published_date_range: {
        min: dateForApi(filters.dateFrom, 30),
        max: dateForApi(filters.dateTo, 0),
      },
      ...(selectedCountry ? { country_code: selectedCountry } : {}),
    },
    max_count: Math.min(limit, 50),
    ...(filters.advertiser || filters.search ? { search_term: filters.advertiser || filters.search } : {}),
    ...(filters.searchMode === "all" ? { search_type: "fuzzy_phrase" } : {}),
    ...(cursor ? { search_id: cursor } : {}),
  };

  const requestUrl = `https://open.tiktokapis.com/v2/research/adlib/ad/query/?fields=${encodeURIComponent(fields)}`;
  const requestHeaders = { Authorization: `Bearer ${config.tiktokAccessToken}`, "Content-Type": "application/json" };
  const logger = await IntegrationLogger.start({
    provider: "tiktok",
    operation: "adlib_query",
    method: "POST",
    url: requestUrl,
    headers: requestHeaders,
    body,
  });
  let response: globalThis.Response | undefined;
  let rawResponse: unknown;
  const parseAttempts: unknown[] = [];
  try {
    response = await fetch(requestUrl, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });
    rawResponse = typeof response.text === "function" ? await response.text() : JSON.stringify(await response.json());
    const payload = JSON.parse(String(rawResponse)) as TikTokResponse;
    parseAttempts.push({
      stage: "provider_payload",
      adsReceived: payload.data?.ads?.length ?? 0,
      hasMore: payload.data?.has_more ?? false,
      hasSearchId: Boolean(payload.data?.search_id),
      providerError: payload.error ?? null,
    });
    if (!response.ok || (payload.error?.code && payload.error.code !== "ok")) {
      throw new Error(payload.error?.message ?? `TikTok API: HTTP ${response.status}`);
    }

    const mapped: AdCreative[] = (payload.data?.ads ?? []).map((item, index) => {
      const ad = item.ad ?? {};
      const advertiser = item.advertiser ?? {};
      const id = String(ad.id ?? `${Date.now()}-${index}`);
      const video = ad.videos?.find((candidate) => candidate.url)?.url;
      const image = ad.image_urls?.[0];
      const startedAt = ad.first_shown_date ? `${ad.first_shown_date.slice(0, 4)}-${ad.first_shown_date.slice(4, 6)}-${ad.first_shown_date.slice(6, 8)}T00:00:00Z` : new Date().toISOString();
      const endedAt = ad.last_shown_date ? `${ad.last_shown_date.slice(0, 4)}-${ad.last_shown_date.slice(4, 6)}-${ad.last_shown_date.slice(6, 8)}T00:00:00Z` : undefined;
      const normalized: AdCreative = {
        id: `tiktok-${id}`,
        source: "tiktok",
        advertiser: advertiser.business_name ?? `Advertiser ${advertiser.business_id ?? id}`,
        country: selectedCountry ?? "EU",
        countryName: selectedCountry ?? "Европейская экономическая зона",
        platforms: ["TikTok"],
        mediaType: video ? "video" : "image",
        mediaUrl: video ?? image ?? "",
        thumbnailUrl: image ?? "",
        headline: advertiser.business_name ?? "TikTok Ad",
        body: advertiser.paid_for_by ?? advertiser.paid_by ?? "Публичное рекламное объявление TikTok.",
        cta: "Открыть",
        sourceUrl: "https://library.tiktok.com/ads/",
        startedAt,
        endedAt,
        daysActive: Math.max(1, Math.ceil(((endedAt ? Date.parse(endedAt) : Date.now()) - Date.parse(startedAt)) / 86_400_000)),
        reach: parseReach(ad.reach?.unique_users_seen),
        savedCount: 0,
        language: "",
      };
      parseAttempts.push({
        stage: "normalize_card",
        externalId: id,
        inputs: {
          hasVideo: Boolean(video),
          hasImage: Boolean(image),
          hasAdvertiserName: Boolean(advertiser.business_name),
          rawReach: ad.reach?.unique_users_seen ?? null,
          firstShownDate: ad.first_shown_date ?? null,
          lastShownDate: ad.last_shown_date ?? null,
        },
        output: normalized,
      });
      return normalized;
    });

    const items = filterAds(mapped, filters);
    parseAttempts.push({ stage: "local_filters", before: mapped.length, after: items.length, filters });
    const result: AdsResponse = {
      items,
      nextCursor: payload.data?.has_more ? payload.data.search_id ?? null : null,
      total: mapped.length,
      mode: "live",
      limitations: ["TikTok Commercial Content API на старте охватывает рекламные данные ЕЭЗ и требует одобренный research.adlib.basic доступ."],
    };
    await logger.success({ responseStatus: response.status, responseHeaders: response.headers, responseBody: rawResponse, parseAttempts });
    return result;
  } catch (error) {
    await logger.error(error, {
      responseStatus: response?.status,
      responseHeaders: response?.headers,
      responseBody: rawResponse,
      parseAttempts,
    });
    throw error;
  }
}
