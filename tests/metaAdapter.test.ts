import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/config.js", () => ({
  config: {
    metaAccessToken: "test-token",
    metaGraphVersion: "v26.0",
  },
}));

import { fetchMetaAds } from "../server/adapters/meta.js";

describe("fetchMetaAds", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not discard search matches already selected by Meta", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{
          id: "123",
          page_name: "Example advertiser",
          ad_delivery_start_time: "2026-08-01T00:00:00+0000",
          ad_creative_bodies: ["Provider-selected creative"],
          ad_creative_link_captions: ["shop.example"],
          languages: ["en"],
          eu_total_reach: 12345,
          ad_snapshot_url: "https://www.facebook.com/ads/archive/render_ad/?id=123&access_token=secret",
        }],
        paging: { cursors: { after: "next-page" } },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchMetaAds({
      search: "nike",
      country: "DE",
      language: "en",
      mediaType: "video",
      platform: "Instagram",
    }, undefined, 1);

    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestUrl.searchParams.get("search_terms")).toBe("nike");
    expect(requestUrl.searchParams.get("ad_reached_countries")).toBe('["DE"]');
    expect(requestUrl.searchParams.get("languages")).toBe('["en"]');
    expect(requestUrl.searchParams.get("media_type")).toBe("VIDEO");
    expect(requestUrl.searchParams.get("publisher_platforms")).toBe('["INSTAGRAM"]');
    expect(requestUrl.searchParams.get("fields")).toContain("ad_creative_link_captions");
    expect(requestUrl.searchParams.get("fields")).toContain("eu_total_reach");

    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.mode).toBe("live");
    expect(result.nextCursor).toBe("next-page");
    expect(result.items[0]).toMatchObject({
      reach: 12345,
      appUrl: "shop.example",
      landingUrl: "https://shop.example/",
      language: "en",
      mediaUrl: "",
      thumbnailUrl: "",
      sourceUrl: "https://www.facebook.com/ads/library/?id=123",
    });
    expect(JSON.stringify(result)).not.toContain("access_token");
  });
});
