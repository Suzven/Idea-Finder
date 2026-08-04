export type AdSource = "meta" | "tiktok";
export type MediaType = "image" | "video" | "carousel";

export interface AdCreative {
  id: string;
  source: AdSource;
  advertiser: string;
  advertiserAvatar?: string;
  country: string;
  countryName: string;
  platforms: string[];
  mediaType: MediaType;
  mediaUrl: string;
  thumbnailUrl: string;
  carousel?: string[];
  headline: string;
  body: string;
  cta: string;
  landingUrl?: string;
  sourceUrl?: string;
  startedAt: string;
  endedAt?: string;
  daysActive: number;
  reach?: number;
  savedCount: number;
  language: string;
  appUrl?: string;
  isFavorite?: boolean;
}

export interface AdsResponse {
  items: AdCreative[];
  nextCursor: string | null;
  total: number;
  mode: "demo" | "live";
  limitations?: string[];
}

export interface AdFilters {
  search: string;
  searchMode: "all" | "exact" | "media";
  country: string;
  app: string;
  mediaType: "all" | MediaType;
  language: string;
  dateFrom: string;
  dateTo: string;
  platform: string;
  reachFrom: string;
  reachTo: string;
  advertiser: string;
  durationFrom: string;
  durationTo: string;
  savedFrom: string;
  savedTo: string;
}

export const EMPTY_FILTERS: AdFilters = {
  search: "",
  searchMode: "all",
  country: "",
  app: "",
  mediaType: "all",
  language: "",
  dateFrom: "",
  dateTo: "",
  platform: "",
  reachFrom: "",
  reachTo: "",
  advertiser: "",
  durationFrom: "",
  durationTo: "",
  savedFrom: "",
  savedTo: "",
};
