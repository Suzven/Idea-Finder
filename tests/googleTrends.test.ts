import { describe, expect, it } from "vitest";
import { mergeGoogleTrendsBatches, parseGoogleTrendsJson, parseRelatedSearches } from "../server/services/googleTrends";

describe("Google Trends parser", () => {
  it("removes Google's anti-XSSI prefix", () => {
    expect(parseGoogleTrendsJson(")]}'\n{\"widgets\":[{\"id\":\"TIMESERIES\"}]}"))
      .toEqual({ widgets: [{ id: "TIMESERIES" }] });
  });

  it("reads top and rising queries for the selected seed keyword", () => {
    expect(parseRelatedSearches({
      default: {
        rankedList: [
          { rankedKeyword: [{ query: "ai companion", value: 100, formattedValue: "100" }] },
          { rankedKeyword: [{ query: "ai girlfriend app", value: 3_200, formattedValue: "+3 200%" }] },
        ],
      },
    }, "ai girlfriend")).toEqual({
      keyword: "ai girlfriend",
      top: [{ query: "ai companion", value: 100, formattedValue: "100" }],
      rising: [{ query: "ai girlfriend app", value: 3_200, formattedValue: "+3 200%" }],
    });
  });

  it("merges a 6–8 keyword comparison through the common anchor", () => {
    const keywords = ["anchor", "two", "three", "four", "five", "six"];
    const batches = [
      {
        keywords: keywords.slice(0, 5),
        timeline: [
          { timestamp: 1, label: "Jan", values: [50, 20, 30, 40, 10] },
          { timestamp: 2, label: "Feb", values: [100, 30, 50, 60, 20] },
        ],
        averages: [75, 25, 40, 50, 15],
        related: new Map(keywords.slice(0, 5).map((keyword) => [keyword, { keyword, top: [], rising: [] }])),
        regions: [],
      },
      {
        keywords: ["anchor", "six"],
        timeline: [
          { timestamp: 1, label: "Jan", values: [25, 50] },
          { timestamp: 2, label: "Feb", values: [50, 100] },
        ],
        averages: [37.5, 75],
        related: new Map([
          ["anchor", { keyword: "anchor", top: [], rising: [] }],
          ["six", { keyword: "six", top: [{ query: "six app", value: 100 }], rising: [] }],
        ]),
        regions: [],
      },
    ] as Parameters<typeof mergeGoogleTrendsBatches>[1];

    const result = mergeGoogleTrendsBatches(keywords, batches);
    expect(result.normalized).toBe(true);
    expect(result.timeline).toHaveLength(2);
    expect(result.timeline[1].values).toHaveLength(6);
    expect(result.timeline[1].values[5]).toBe(100);
    expect(result.related.find((item) => item.keyword === "six")?.top[0]?.query).toBe("six app");
  });
});
