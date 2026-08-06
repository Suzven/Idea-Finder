import { describe, expect, it } from "vitest";
import {
  buildCapterraCandidates,
  buildProductHuntCandidates,
  buildSoftwareAdviceCandidates,
  buildTrustpilotCandidates,
  isSoftwareAdviceProfileUrl,
  normalizeCompanyQuery,
  scoreSoftwareAdviceResult,
  shouldRetryReviewSource,
} from "../server/services/reviewAnalysis";

describe("review analysis URL adapters", () => {
  it("normalizes a company URL into domain and product slug", () => {
    expect(normalizeCompanyQuery("https://www.AppsFlyer.com/reviews?from=test")).toEqual({
      domain: "appsflyer.com",
      slug: "appsflyer",
    });
  });

  it("tries Trustpilot name and domain variants without duplicates", () => {
    expect(buildTrustpilotCandidates("appsflyer")).toEqual([
      "https://www.trustpilot.com/review/www.appsflyer.com",
      "https://www.trustpilot.com/review/appsflyer.com",
      "https://www.trustpilot.com/review/appsflyer",
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

  it("selects the exact Software Advice product suggestion", () => {
    expect(scoreSoftwareAdviceResult("AppsFlyer", "appsflyer")).toBe(100);
    expect(scoreSoftwareAdviceResult("eFlyerMaker", "appsflyer")).toBeLessThan(100);
  });

  it("accepts product profiles but rejects the Software Advice home page", () => {
    expect(isSoftwareAdviceProfileUrl("https://www.softwareadvice.com/mobile-marketing/appsflyer-profile/")).toBe(true);
    expect(isSoftwareAdviceProfileUrl("https://www.softwareadvice.com/product/548339-Perso-AI/")).toBe(true);
    expect(isSoftwareAdviceProfileUrl("https://www.softwareadvice.com/#reviews")).toBe(false);
  });

  it("builds Product Hunt review URLs from a name, domain, or product URL", () => {
    expect(buildProductHuntCandidates("ElevenLabs")[0]).toBe(
      "https://www.producthunt.com/products/elevenlabs/reviews?feed=single&filter=all",
    );
    expect(buildProductHuntCandidates("elevenlabs.io")[0]).toBe(
      "https://www.producthunt.com/products/elevenlabs/reviews?feed=single&filter=all",
    );
    expect(buildProductHuntCandidates("https://www.producthunt.com/products/elevenlabs/reviews")[0]).toBe(
      "https://www.producthunt.com/products/elevenlabs/reviews?feed=single&filter=all",
    );
  });

  it("retries only transient source failures after the first pass", () => {
    expect(shouldRetryReviewSource({ status: "error" })).toBe(true);
    expect(shouldRetryReviewSource({ status: "blocked" })).toBe(true);
    expect(shouldRetryReviewSource({ status: "found" })).toBe(false);
    expect(shouldRetryReviewSource({ status: "not_found" })).toBe(false);
  });
});
