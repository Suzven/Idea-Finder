import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, buildAnalysisPrompt } from "../server/services/aiAnalysis";
import type { AdCreative, CreativeCollection } from "../src/shared/types";

const collection: CreativeCollection = {
  id: "7",
  name: "Товары для сна",
  itemCount: 1,
  createdAt: "2026-08-05T00:00:00.000Z",
};

const ad: AdCreative = {
  id: "meta-123",
  source: "meta",
  advertiser: "Sleep Lab",
  country: "US",
  countryName: "США",
  countries: ["США", "Канада"],
  platforms: ["facebook", "instagram"],
  mediaType: "video",
  mediaUrl: "/api/meta/media/123/content",
  thumbnailUrl: "/api/meta/media/123/thumbnail",
  headline: "Sleep deeper tonight",
  body: "Cooling pillow with adjustable support",
  cta: "В магазин",
  landingUrl: "https://example.com/pillow",
  startedAt: "2026-07-01",
  endedAt: "2026-07-21",
  daysActive: 21,
  reach: 120000,
  savedCount: 0,
  language: "en",
};

describe("AI collection analysis", () => {
  it("puts ad copy, delivery statistics and landing mapping into the prompt", () => {
    const prompt = buildAnalysisPrompt(collection, [{ ad, landingUrl: ad.landingUrl }]);
    expect(prompt).toContain("Товары для сна");
    expect(prompt).toContain("Sleep deeper tonight");
    expect(prompt).toContain("Cooling pillow with adjustable support");
    expect(prompt).toContain('"daysActive": 21');
    expect(prompt).toContain('"reachOrViews": 120000');
    expect(prompt).toContain("сначала креатив/первый кадр");
  });

  it.each([
    "http://127.0.0.1/admin",
    "http://10.0.0.2/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
  ])("blocks private landing URL %s", async (url) => {
    await expect(assertPublicHttpUrl(url)).rejects.toThrow(/Внутренние адреса/);
  });
});
