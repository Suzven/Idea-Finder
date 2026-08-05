import type { AdCreative, AdFilters, AdsResponse } from "../../src/shared/types.js";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { filterAds } from "../services/filterAds.js";
import { IntegrationLogger } from "../services/integrationLogger.js";
import { registerMetaAd } from "../services/metaSnapshot.js";

interface MetaAd {
  id: string;
  page_id?: string;
  page_name?: string;
  ad_creation_time?: string;
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_captions?: string[];
  ad_creative_link_titles?: string[];
  ad_creative_link_descriptions?: string[];
  publisher_platforms?: string[];
  languages?: string[];
  eu_total_reach?: number | string;
  estimated_audience_size?: { lower_bound?: string; upper_bound?: string };
  impressions?: { lower_bound?: string; upper_bound?: string };
  ad_snapshot_url?: string;
}

interface MetaResponse {
  data?: MetaAd[];
  paging?: { cursors?: { after?: string }; next?: string };
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
  };
}

function isInvalidAccessToken(error: MetaResponse["error"]): boolean {
  if (!error) return false;
  return error.code === 190
    || /session has expired|error validating access token|invalid oauth access token/i.test(error.message ?? "");
}

function normalizeWebsite(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function firstUrl(values: Array<string[] | undefined>): string | undefined {
  for (const value of values.flatMap((entry) => entry ?? [])) {
    const match = value.match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.;!?]+$/, "");
    if (match) return normalizeWebsite(match);
  }
  return undefined;
}

function parseReach(ad: MetaAd): number | undefined {
  const raw = ad.eu_total_reach
    ?? ad.impressions?.upper_bound
    ?? ad.impressions?.lower_bound
    ?? ad.estimated_audience_size?.upper_bound
    ?? ad.estimated_audience_size?.lower_bound;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export async function fetchMetaAds(filters: Partial<AdFilters>, cursor: string | undefined, limit: number): Promise<AdsResponse> {
  if (!config.metaAccessToken) throw new Error("META_ACCESS_TOKEN не настроен");
  const selectedCountries = filters.country?.length ? filters.country : ["US"];
  const searchTerms = filters.search?.trim() || "sale";
  const params = new URLSearchParams({
    access_token: config.metaAccessToken,
    ad_type: "ALL",
    ad_active_status: "ALL",
    ad_reached_countries: JSON.stringify(selectedCountries),
    search_terms: searchTerms,
    fields: [
      "id", "page_id", "page_name", "ad_creation_time", "ad_delivery_start_time",
      "ad_delivery_stop_time", "ad_creative_bodies", "ad_creative_link_captions",
      "ad_creative_link_titles", "ad_creative_link_descriptions",
      "publisher_platforms", "languages", "eu_total_reach", "estimated_audience_size", "impressions",
      "ad_snapshot_url",
    ].join(","),
    limit: String(Math.min(limit, 50)),
  });
  if (filters.searchMode === "exact") params.set("search_type", "KEYWORD_EXACT_PHRASE");
  if (filters.dateFrom) params.set("ad_delivery_date_min", filters.dateFrom);
  if (filters.dateTo) params.set("ad_delivery_date_max", filters.dateTo);
  if (filters.language?.length) params.set("languages", JSON.stringify(filters.language));
  if (filters.mediaType === "image" || filters.mediaType === "video") {
    params.set("media_type", filters.mediaType.toUpperCase());
  }
  if (filters.platform) {
    const platform = filters.platform === "Audience" ? "AUDIENCE_NETWORK" : filters.platform.toUpperCase();
    params.set("publisher_platforms", JSON.stringify([platform]));
  }
  if (cursor) params.set("after", cursor);

  const requestUrl = `https://graph.facebook.com/${config.metaGraphVersion}/ads_archive?${params}`;
  const logger = await IntegrationLogger.start({
    provider: "meta",
    operation: "ads_archive_query",
    method: "GET",
    url: requestUrl,
    body: { queryParameters: Object.fromEntries(params.entries()) },
  });
  let response: globalThis.Response | undefined;
  let rawResponse: unknown;
  const parseAttempts: unknown[] = [];
  try {
    response = await fetch(requestUrl);
    rawResponse = typeof response.text === "function" ? await response.text() : JSON.stringify(await response.json());
    const payload = JSON.parse(String(rawResponse)) as MetaResponse;
    parseAttempts.push({
      stage: "provider_payload",
      dataIsArray: Array.isArray(payload.data),
      adsReceived: payload.data?.length ?? 0,
      adsWithSnapshotUrl: payload.data?.filter((ad) => Boolean(ad.ad_snapshot_url)).length ?? 0,
      hasPagingCursor: Boolean(payload.paging?.cursors?.after),
      providerError: payload.error ?? null,
    });
    if (isInvalidAccessToken(payload.error)) {
      throw new AppError(
        401,
        "META_TOKEN_EXPIRED",
        "Токен Meta истёк, был отозван или больше не действителен.",
        "Получите новый долгосрочный User Access Token, замените META_ACCESS_TOKEN в защищённом env-файле и перезапустите сервис.",
      );
    }
    if (!response.ok || payload.error) throw new Error(payload.error?.message ?? `Meta API: HTTP ${response.status}`);

    const mapped: AdCreative[] = (payload.data ?? []).map((ad) => {
      const startedAt = ad.ad_delivery_start_time ?? ad.ad_creation_time ?? new Date().toISOString();
      const endedAt = ad.ad_delivery_stop_time;
      const daysActive = Math.max(1, Math.ceil(((endedAt ? Date.parse(endedAt) : Date.now()) - Date.parse(startedAt)) / 86_400_000));
      const displayWebsite = ad.ad_creative_link_captions?.[0]?.trim();
      const landingUrl = firstUrl([ad.ad_creative_bodies, ad.ad_creative_link_descriptions])
        ?? normalizeWebsite(displayWebsite);
      const normalized: AdCreative = {
        id: `meta-${ad.id}`,
        source: "meta",
        advertiser: ad.page_name ?? `Страница ${ad.page_id ?? ad.id}`,
        country: selectedCountries.length === 1 ? selectedCountries[0] : `${selectedCountries[0]}+${selectedCountries.length - 1}`,
        countryName: selectedCountries.join(", "),
        platforms: (ad.publisher_platforms ?? ["Facebook"]).map((value) => value.replaceAll("_", " ")),
        mediaType: filters.mediaType === "video" ? "video" : "image",
        mediaUrl: "",
        thumbnailUrl: "",
        mediaInfoUrl: registerMetaAd(ad.id, ad.ad_snapshot_url),
        headline: ad.ad_creative_link_titles?.[0] ?? "Объявление Meta",
        body: ad.ad_creative_bodies?.[0] ?? ad.ad_creative_link_descriptions?.[0] ?? "Откройте оригинал объявления для просмотра креатива.",
        cta: "Открыть объявление",
        landingUrl,
        appUrl: displayWebsite,
        // ad_snapshot_url contains the access token, so it must never reach the browser.
        sourceUrl: `https://www.facebook.com/ads/library/?id=${encodeURIComponent(ad.id)}`,
        startedAt,
        endedAt,
        daysActive,
        reach: parseReach(ad),
        savedCount: 0,
        language: ad.languages?.[0] ?? "",
      };
      parseAttempts.push({
        stage: "normalize_card",
        externalId: ad.id,
        inputs: {
          hasPageName: Boolean(ad.page_name),
          bodyCount: ad.ad_creative_bodies?.length ?? 0,
          titleCount: ad.ad_creative_link_titles?.length ?? 0,
          captionCount: ad.ad_creative_link_captions?.length ?? 0,
          platforms: ad.publisher_platforms ?? [],
          hasSnapshotUrl: Boolean(ad.ad_snapshot_url),
          rawReach: ad.eu_total_reach ?? ad.impressions ?? ad.estimated_audience_size ?? null,
        },
        output: normalized,
      });
      return normalized;
    });

    // Meta has already applied these filters. Applying them again locally can
    // incorrectly discard fuzzy matches returned by the provider (for example,
    // a search term that is present in data not included in the requested fields).
    const {
      search: _search,
      searchMode: _searchMode,
      country: _country,
      dateFrom: _dateFrom,
      dateTo: _dateTo,
      language: _language,
      mediaType: _mediaType,
      platform: _platform,
      ...localFilters
    } = filters;
    const items = filterAds(mapped, localFilters);
    parseAttempts.push({ stage: "local_filters", before: mapped.length, after: items.length, filters: localFilters });

    const result: AdsResponse = {
      items,
      nextCursor: payload.paging?.cursors?.after ?? null,
      total: items.length,
      mode: "live",
      limitations: ["Медиа и аватар рекламной страницы извлекаются из публичной страницы объявления Meta и кешируются на сервере. Некоторые удалённые или ограниченные объявления могут не отдавать креатив. Домен берётся из отображаемой подписи и может отличаться от конечного URL перехода."],
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
