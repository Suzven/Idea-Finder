import { describe, expect, it } from "vitest";
import { demoAds } from "../server/data/demoAds.js";
import { filterAds } from "../server/services/filterAds.js";

describe("filterAds", () => {
  it("filters Meta ads by country and media type", () => {
    const result = filterAds(demoAds.meta, { country: "DE", mediaType: "image" });
    expect(result).toHaveLength(1);
    expect(result[0].country).toBe("DE");
  });

  it("supports advertiser search and numeric ranges", () => {
    const result = filterAds(demoAds.tiktok, { advertiser: "Aster", durationFrom: "10" });
    expect(result).toHaveLength(1);
    expect(result[0].advertiser).toContain("Aster");
  });

  it("matches all words in a fuzzy search", () => {
    const result = filterAds(demoAds.meta, { search: "нового поколения", searchMode: "all" });
    expect(result.length).toBeGreaterThan(0);
  });
});
