import { describe, expect, it } from "vitest";
import { buildG2Candidates, buildTrustpilotCandidates, normalizeCompanyQuery } from "../server/services/reviewAnalysis";

describe("review analysis URL adapters", () => {
  it("normalizes a company URL into domain and product slug", () => {
    expect(normalizeCompanyQuery("https://www.AppsFlyer.com/reviews?from=test")).toEqual({
      domain: "appsflyer.com",
      slug: "appsflyer",
    });
  });

  it("tries Trustpilot name and domain variants without duplicates", () => {
    expect(buildTrustpilotCandidates("appsflyer")).toEqual([
      "https://www.trustpilot.com/review/appsflyer",
      "https://www.trustpilot.com/review/appsflyer.com",
      "https://www.trustpilot.com/review/www.appsflyer.com",
    ]);
  });

  it("tries G2 product slug and domain-shaped variants", () => {
    expect(buildG2Candidates("www.appsflyer.com")).toEqual([
      "https://www.g2.com/products/appsflyer/reviews",
      "https://www.g2.com/products/appsflyer-com/reviews",
      "https://www.g2.com/products/www-appsflyer-com/reviews",
    ]);
  });
});
