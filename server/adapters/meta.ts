import type { AdCreative, AdFilters, AdsResponse } from "../../src/shared/types.js";
import { config } from "../config.js";
import { filterAds } from "../services/filterAds.js";

interface MetaAd {
  id: string;
  page_id?: string;
  page_name?: string;
  ad_creation_time?: string;
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_creative_link_descriptions?: string[];
  ad_snapshot_url?: string;
  publisher_platforms?: string[];
  impressions?: { lower_bound?: string; upper_bound?: string };
}

interface MetaResponse {
  data?: MetaAd[];
  paging?: { cursors?: { after?: string }; next?: string };
  error?: { message?: string };
}

const fallbackThumb = "https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?auto=format&fit=crop&w=900&q=82";

export async function fetchMetaAds(filters: Partial<AdFilters>, cursor: string | undefined, limit: number): Promise<AdsResponse> {
  if (!config.metaAccessToken) throw new Error("META_ACCESS_TOKEN не настроен");
  const params = new URLSearchParams({
    access_token: config.metaAccessToken,
    ad_type: "ALL",
    ad_active_status: "ALL",
    ad_reached_countries: JSON.stringify(filters.country ? [filters.country] : ["ALL"]),
    fields: [
      "id", "page_id", "page_name", "ad_creation_time", "ad_delivery_start_time",
      "ad_delivery_stop_time", "ad_creative_bodies", "ad_creative_link_titles",
      "ad_creative_link_descriptions", "ad_snapshot_url", "publisher_platforms", "impressions",
    ].join(","),
    limit: String(Math.min(limit, 50)),
  });
  if (filters.search) params.set("search_terms", filters.search);
  if (filters.searchMode === "exact") params.set("search_type", "KEYWORD_EXACT_PHRASE");
  if (filters.dateFrom) params.set("ad_delivery_date_min", filters.dateFrom);
  if (filters.dateTo) params.set("ad_delivery_date_max", filters.dateTo);
  if (cursor) params.set("after", cursor);

  const response = await fetch(`https://graph.facebook.com/${config.metaGraphVersion}/ads_archive?${params}`);
  const payload = await response.json() as MetaResponse;
  if (!response.ok || payload.error) throw new Error(payload.error?.message ?? `Meta API: HTTP ${response.status}`);

  const mapped: AdCreative[] = (payload.data ?? []).map((ad) => {
    const startedAt = ad.ad_delivery_start_time ?? ad.ad_creation_time ?? new Date().toISOString();
    const endedAt = ad.ad_delivery_stop_time;
    const daysActive = Math.max(1, Math.ceil(((endedAt ? Date.parse(endedAt) : Date.now()) - Date.parse(startedAt)) / 86_400_000));
    return {
      id: `meta-${ad.id}`,
      source: "meta",
      advertiser: ad.page_name ?? `Страница ${ad.page_id ?? ad.id}`,
      country: filters.country ?? "ALL",
      countryName: filters.country ?? "Все страны",
      platforms: (ad.publisher_platforms ?? ["Facebook"]).map((value) => value.replaceAll("_", " ")),
      mediaType: "image",
      mediaUrl: fallbackThumb,
      thumbnailUrl: fallbackThumb,
      headline: ad.ad_creative_link_titles?.[0] ?? "Объявление Meta",
      body: ad.ad_creative_bodies?.[0] ?? ad.ad_creative_link_descriptions?.[0] ?? "Откройте оригинал объявления для просмотра креатива.",
      cta: "Открыть объявление",
      sourceUrl: ad.ad_snapshot_url ?? `https://www.facebook.com/ads/library/?id=${ad.id}`,
      startedAt,
      endedAt,
      daysActive,
      reach: Number(ad.impressions?.upper_bound ?? ad.impressions?.lower_bound ?? 0) || undefined,
      savedCount: 0,
      language: "",
    };
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
    ...localFilters
  } = filters;
  const items = filterAds(mapped, localFilters);

  return {
    items,
    nextCursor: payload.paging?.cursors?.after ?? null,
    total: items.length,
    mode: "live",
    limitations: ["Meta Ad Library API отдаёт ссылку на snapshot, но не прямой URL медиафайла; оригинал открывается в библиотеке Meta."],
  };
}
