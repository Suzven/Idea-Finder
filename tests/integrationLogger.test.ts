import { describe, expect, it } from "vitest";
import { sanitizeLogValue } from "../server/services/integrationLogger.js";

describe("sanitizeLogValue", () => {
  it("redacts provider secrets while preserving useful request details", () => {
    const sanitized = sanitizeLogValue({
      Authorization: "Bearer tiktok-secret",
      query: {
        access_token: "meta-secret",
        search_terms: "shoes",
      },
      url: "https://graph.facebook.com/ads_archive?access_token=meta-secret&limit=12",
    });

    expect(sanitized).toEqual({
      Authorization: "[REDACTED]",
      query: {
        access_token: "[REDACTED]",
        search_terms: "shoes",
      },
      url: "https://graph.facebook.com/ads_archive?access_token=[REDACTED]&limit=12",
    });
    expect(JSON.stringify(sanitized)).not.toContain("meta-secret");
    expect(JSON.stringify(sanitized)).not.toContain("tiktok-secret");
  });
});
