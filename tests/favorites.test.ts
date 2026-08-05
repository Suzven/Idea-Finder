import { describe, expect, it, vi } from "vitest";

vi.mock("../server/config.js", () => ({ config: {} }));

import { addFavorite, createCollection, deleteAIAnalysisReport, deleteCollection, getAIAnalysisReport, getAIAnalysisReports, getCollections, getFavoriteAds, getFavoriteIds, removeFavorite, saveAIAnalysisReport, setCreativeAnalysisNotes } from "../server/db.js";
import type { AdCreative, AIAnalysisResponse } from "../src/shared/types.js";

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

  it("groups saved creatives into named collections", async () => {
    const clientId = "favorite-collections-test";
    const collection = await createCollection(clientId, "Winning videos");

    expect(await addFavorite(clientId, creative, collection.id)).toBe(true);
    expect(await getFavoriteAds(clientId, collection.id)).toHaveLength(1);
    expect(await getCollections(clientId)).toEqual([{ ...collection, itemCount: 1 }]);

    const otherCollection = await createCollection(clientId, "Empty collection");
    expect(await getFavoriteAds(clientId, otherCollection.id)).toEqual([]);
  });

  it("rejects a collection owned by another client", async () => {
    const collection = await createCollection("collection-owner", "Private");
    expect(await addFavorite("different-client", creative, collection.id)).toBe(false);
  });

  it("deletes a collection and its saved creatives", async () => {
    const clientId = "cascade-delete-test";
    const collection = await createCollection(clientId, "Temporary");
    await addFavorite(clientId, creative, collection.id);

    expect(await deleteCollection(clientId, collection.id)).toBe(1);
    expect(await getCollections(clientId)).toEqual([]);
    expect(await getFavoriteAds(clientId)).toEqual([]);
    expect(await getFavoriteIds(clientId)).toEqual(new Set());
  });

  it("stores a manual video description for the analysis prompt", async () => {
    const clientId = "creative-note-test";
    const collection = await createCollection(clientId, "Video notes");
    await addFavorite(clientId, creative, collection.id);

    expect(await setCreativeAnalysisNotes(clientId, collection.id, [creative.id], "Девушка танцует")).toBe(1);
    expect((await getFavoriteAds(clientId, collection.id))[0].analysisNote).toBe("Девушка танцует");
  });

  it("stores, opens and deletes a completed AI report", async () => {
    const clientId = "ai-report-test";
    const collection = await createCollection(clientId, "Shoes");
    const result: AIAnalysisResponse = {
      collection,
      model: "gpt-5.6",
      analyzedCount: 1,
      totalCount: 1,
      warnings: [],
      analysis: {
        niche: "Comfort shoes",
        executiveSummary: "Promising",
        opportunityScore: 77,
        confidence: "medium",
        demandSignals: [],
        winningPatterns: [],
        audienceInsights: [],
        landingInsights: [],
        risks: [],
        recommendations: [],
        testPlan: [],
        creativeFindings: [],
        caveats: [],
      },
    };

    const saved = await saveAIAnalysisReport(clientId, collection, result);
    expect(saved.name).toContain("Shoes_");
    expect(await getAIAnalysisReports(clientId)).toHaveLength(1);
    expect((await getAIAnalysisReport(clientId, saved.id))?.result.analysis.opportunityScore).toBe(77);
    expect(await deleteAIAnalysisReport(clientId, saved.id)).toBe(true);
    expect(await getAIAnalysisReports(clientId)).toEqual([]);
  });
});
