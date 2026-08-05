import type { AdCreative, AdFilters } from "../../src/shared/types.js";

const includes = (value: string, query: string) => value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
const asNumber = (value: string) => value === "" ? undefined : Number(value);

export function filterAds(items: AdCreative[], filters: Partial<AdFilters>): AdCreative[] {
  const search = filters.search?.trim() ?? "";
  const reachFrom = asNumber(filters.reachFrom ?? "");
  const reachTo = asNumber(filters.reachTo ?? "");
  const durationFrom = asNumber(filters.durationFrom ?? "");
  const durationTo = asNumber(filters.durationTo ?? "");
  const savedFrom = asNumber(filters.savedFrom ?? "");
  const savedTo = asNumber(filters.savedTo ?? "");

  return items.filter((ad) => {
    if (search) {
      const haystack = `${ad.headline} ${ad.body} ${ad.advertiser}`;
      const matches = filters.searchMode === "exact"
        ? haystack.toLocaleLowerCase().includes(search.toLocaleLowerCase())
        : search.split(/\s+/).every((word) => includes(haystack, word));
      if (!matches) return false;
    }
    const countries = filters.country?.filter((country) => country !== "ALL") ?? [];
    if (countries.length && !countries.includes(ad.country)) return false;
    if (filters.mediaType && filters.mediaType !== "all" && ad.mediaType !== filters.mediaType) return false;
    if (filters.language?.length && !filters.language.includes(ad.language)) return false;
    if (filters.platform && !ad.platforms.some((platform) => includes(platform, filters.platform!))) return false;
    if (filters.app && !includes(ad.appUrl ?? "", filters.app)) return false;
    if (filters.advertiser && !includes(ad.advertiser, filters.advertiser)) return false;
    if (filters.dateFrom && ad.startedAt.slice(0, 10) < filters.dateFrom) return false;
    if (filters.dateTo && ad.startedAt.slice(0, 10) > filters.dateTo) return false;
    if (reachFrom !== undefined && (ad.reach ?? 0) < reachFrom) return false;
    if (reachTo !== undefined && (ad.reach ?? 0) > reachTo) return false;
    if (durationFrom !== undefined && ad.daysActive < durationFrom) return false;
    if (durationTo !== undefined && ad.daysActive > durationTo) return false;
    if (savedFrom !== undefined && ad.savedCount < savedFrom) return false;
    if (savedTo !== undefined && ad.savedCount > savedTo) return false;
    return true;
  });
}
