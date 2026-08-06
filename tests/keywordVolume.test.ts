import { describe, expect, it } from "vitest";
import { collectKeywordVolume } from "../server/services/keywordVolume.js";
import { parseKeywordSurferPayload } from "../server/services/keywordSurfer.js";
import { parseKeywordSurferCsv } from "../src/keywordSurferCsv.js";

describe("keyword volume", () => {
  it("parses Keyword Surfer CSV exports with comma separators", () => {
    const rows = parseKeywordSurferCsv([
      "Keyword,Search Volume,CPC",
      'ai dubbing,"1,900",2.45',
      "video translator,14800,1.1",
    ].join("\n"), "US");

    expect(rows).toEqual([
      { country: "US", keyword: "ai dubbing", volume: 1900, cpc: 2.45 },
      { country: "US", keyword: "video translator", volume: 14800, cpc: 1.1 },
    ]);
  });

  it("maps Keyword Surfer extension responses without inventing missing values", () => {
    expect(parseKeywordSurferPayload({
      "ai dubbing": { search_volume: 1900, cpc: "2.45" },
      "video translator": { search_volume: 14800, cpc: null },
    }, "US", ["ai dubbing", "missing keyword", "video translator"])).toEqual([
      { country: "US", keyword: "ai dubbing", volume: 1900, cpc: 2.45 },
      { country: "US", keyword: "video translator", volume: 14800 },
    ]);
  });

  it("maps imported Surfer values into country and keyword rows", async () => {
    const result = await collectKeywordVolume({
      keywords: ["ai dubbing", "video translator"],
      countries: ["US", "DE"],
      sources: ["keyword_surfer"],
      surferRows: [
        { country: "US", keyword: "ai dubbing", volume: 1900 },
        { country: "DE", keyword: "video translator", volume: 480 },
      ],
    });

    expect(result.rows).toHaveLength(4);
    expect(result.rows.find((row) => row.country === "US" && row.keyword === "ai dubbing")?.metrics.keyword_surfer?.volume).toBe(1900);
    expect(result.rows.find((row) => row.country === "US" && row.keyword === "video translator")?.metrics.keyword_surfer?.status).toBe("no_data");
    expect(result.sources[0]).toMatchObject({ source: "keyword_surfer", status: "partial", received: 2 });
    expect(result.sources[0]?.logs?.[0]).toMatchObject({ stage: "surfer_complete", status: "success" });
  });

  it("returns a safe diagnostic log when Google credentials are missing", async () => {
    const result = await collectKeywordVolume({
      keywords: ["ai dubbing"],
      countries: ["US"],
      sources: ["google_ads"],
    });

    expect(result.sources[0]).toMatchObject({ source: "google_ads", status: "not_configured", received: 0 });
    expect(result.sources[0]?.logs).toEqual([
      expect.objectContaining({ stage: "configuration", status: "error" }),
    ]);
  });
});
