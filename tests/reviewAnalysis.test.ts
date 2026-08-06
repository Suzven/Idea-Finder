import { describe, expect, it } from "vitest";
import { buildCapterraCandidates, buildSoftwareAdviceCandidates, buildTrustpilotCandidates, normalizeCompanyQuery } from "../server/services/reviewAnalysis";

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

  it("builds a Capterra search URL because product IDs cannot be derived from a domain", () => {
    expect(buildCapterraCandidates("www.appsflyer.com")).toEqual([
      "https://www.capterra.com/search/?query=appsflyer",
    ]);
  });

  it("opens Software Advice search because profile URLs use internal product identifiers", () => {
    expect(buildSoftwareAdviceCandidates()).toEqual(["https://www.softwareadvice.com/"]);
  });
});
