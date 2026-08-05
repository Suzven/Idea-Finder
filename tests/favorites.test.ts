import { describe, expect, it, vi } from "vitest";

vi.mock("../server/config.js", () => ({ config: {} }));

import { addFavorite, getFavoriteAds, getFavoriteIds, removeFavorite } from "../server/db.js";
import type { AdCreative } from "../src/shared/types.js";

const creative: AdCreative = {
  id: "meta-persistent-favorite",
  source: "meta",
  advertiser: "Saved advertiser",
  country: "US",
  countryName: "United States",
  platforms: ["facebook"],
  mediaType: "video",
  mediaUrl: "/api/meta/media/persistent-favorite/content",
  thumbnailUrl: "/api/meta/media/persistent-favorite/thumbnail",
  mediaInfoUrl: "/api/meta/media/persistent-favorite",
  headline: "Saved headline",
  body: "Saved body",
  cta: "Open",
  startedAt: "2026-08-01T00:00:00Z",
  daysActive: 5,
  savedCount: 0,
  language: "en",
};

describe("favorites storage", () => {
  it("stores the complete creative so it can be loaded without search results", async () => {
    const clientId = "favorite-persistence-test";

    await addFavorite(clientId, creative);

    expect(await getFavoriteIds(clientId)).toEqual(new Set([creative.id]));
    expect(await getFavoriteAds(clientId)).toEqual([{
      ad: { ...creative, isFavorite: true },
    }]);

    await removeFavorite(clientId, creative.id);
    expect(await getFavoriteAds(clientId)).toEqual([]);
  });
});
