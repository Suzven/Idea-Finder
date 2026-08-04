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
        }],
        paging: { cursors: { after: "next-page" } },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchMetaAds({ search: "nike", country: "DE" }, undefined, 1);

    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.mode).toBe("live");
    expect(result.nextCursor).toBe("next-page");
  });
});
