import { createHash } from "node:crypto";
import type { BrowserContext, Page, Response as PlaywrightResponse } from "playwright";
import type { ReviewAttemptLog, ReviewBrowserInfo, ReviewManualChallenge, ReviewProgressOperation, ReviewProxyTestLog, ReviewProxyTestResult, ReviewSearchResponse, ReviewSource, ReviewSourceProgress, ReviewSourceResult, UserReview } from "../../src/shared/types.js";
import { AppError } from "../errors.js";
import { getMetaBrowser } from "./metaSnapshot.js";
import { registerReviewChallenge } from "./reviewChallenge.js";
import { createAuthenticatedSocks5Bridge, type SocksProxyBridge } from "./socksProxyBridge.js";

export interface ReviewProxyCredentials {
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
}

interface ReviewAdapter {
  source: ReviewSource;
  label: string;
  buildCandidates(query: string): string[];
  resolveCandidates?: (page: Page, query: string) => Promise<string[]>;
  openResolvedCandidate?: (page: Page, candidate: string) => Promise<{ response?: PlaywrightResponse; warning?: string }>;
  advancePage?: (page: Page, pageNumber: number) => Promise<boolean>;
  prepare?: (page: Page) => Promise<void>;
  extract(page: Page, pageNumber: number): Promise<{ companyName?: string; reviews: UserReview[] }>;
}

const MAX_PAGES = 6;
const NAVIGATION_TIMEOUT_MS = 35_000;
const CHALLENGE_WAIT_MS = 45_000;
const MANUAL_CHALLENGE_WAIT_MS = 5 * 60_000;

interface ReviewScrapeOptions {
  challengeOwnerId?: string;
  onChallengeChange?: (challenge?: ReviewManualChallenge) => void;
  onActivity?: (activity: Omit<ReviewProgressOperation, "at" | "elapsedMs">) => void;
}

export function normalizeCompanyQuery(value: string): { domain: string; slug: string } {
  let normalized = value.trim().toLowerCase();
  normalized = normalized.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/, 1)[0] ?? "";
  normalized = normalized.replace(/\.+$/, "").replace(/[^a-z0-9.-]/g, "");
  const slug = normalized.split(".")[0]?.replace(/[^a-z0-9-]/g, "") ?? "";
  return { domain: normalized, slug };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function buildTrustpilotCandidates(query: string): string[] {
  const { domain, slug } = normalizeCompanyQuery(query);
  return unique([
    domain,
    domain.includes(".") ? `www.${domain}` : "",
    slug,
    slug ? `${slug}.com` : "",
    slug ? `www.${slug}.com` : "",
  ]).map((candidate) => `https://www.trustpilot.com/review/${candidate}`);
}

export function buildCapterraCandidates(query: string): string[] {
  const normalized = normalizeCompanyQuery(query);
  const searchTerm = normalized.slug || normalized.domain || query.trim();
  return [`https://www.capterra.com/search/?query=${encodeURIComponent(searchTerm)}`];
}

export function buildSoftwareAdviceCandidates(): string[] {
  return ["https://www.softwareadvice.com/"];
}

export function buildProductHuntCandidates(query: string): string[] {
  const raw = query.trim().toLowerCase();
  const productPath = raw.match(/producthunt\.com\/products\/([^/?#]+)/i)?.[1] ?? "";
  const withoutProtocol = raw.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const companyValue = withoutProtocol.split(/[/?#]/, 1)[0] ?? "";
  const withoutTld = companyValue.includes(".") ? companyValue.split(".")[0] ?? "" : companyValue;
  const dashed = raw
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\.[a-z]{2,}(?:\.[a-z]{2})?$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const compact = withoutTld.replace(/[^a-z0-9]+/g, "");
  return unique([productPath, compact, dashed])
    .map((slug) => `https://www.producthunt.com/products/${slug}/reviews?feed=single&filter=all`);
}

function normalizeSearchLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function scoreSoftwareAdviceResult(label: string, query: string): number {
  const normalizedLabel = normalizeSearchLabel(label);
  const normalizedQuery = normalizeSearchLabel(query);
  if (!normalizedLabel || !normalizedQuery) return 0;
  if (normalizedLabel === normalizedQuery) return 100;
  if (normalizedLabel.includes(normalizedQuery) || normalizedQuery.includes(normalizedLabel)) return 80;
  const queryWords = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return queryWords.filter((word) => normalizedLabel.includes(word)).length * 10;
}

export function isSoftwareAdviceProfileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "www.softwareadvice.com"
      && url.pathname !== "/"
      && (/-profile\/?$/i.test(url.pathname) || /^\/product\/[^/]+\/?$/i.test(url.pathname));
  } catch {
    return false;
  }
}

function pageUrl(baseUrl: string, pageNumber: number): string {
  if (pageNumber === 1) return baseUrl;
  const url = new URL(baseUrl);
  url.searchParams.set("page", String(pageNumber));
  return url.toString();
}

function reviewId(review: Omit<UserReview, "id">): string {
  return createHash("sha256")
    .update([review.source, review.author, review.date, review.title, review.text].join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

function deduplicateReviews(reviews: UserReview[]): UserReview[] {
  const seen = new Set<string>();
  return reviews.filter((review) => {
    if (seen.has(review.id)) return false;
    seen.add(review.id);
    return true;
  });
}

function isNavigationRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /navigation.+interrupted|execution context was destroyed|cannot find context with specified id/i.test(message);
}

async function waitForNavigationToSettle(page: Page): Promise<void> {
  const deadline = Date.now() + 8_000;
  let lastUrl = "";
  let stableChecks = 0;
  while (Date.now() < deadline && !page.isClosed()) {
    await page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => undefined);
    const currentUrl = page.url();
    stableChecks = currentUrl === lastUrl ? stableChecks + 1 : 0;
    lastUrl = currentUrl;
    if (stableChecks >= 2) return;
    await page.waitForTimeout(350);
  }
}

async function navigateStable(page: Page, url: string): Promise<{ response?: PlaywrightResponse; warning?: string }> {
  let response: PlaywrightResponse | null = null;
  let latestDocumentResponse: PlaywrightResponse | undefined;
  let warning: string | undefined;
  const captureDocumentResponse = (candidate: PlaywrightResponse) => {
    if (candidate.request().resourceType() === "document") latestDocumentResponse = candidate;
  };
  page.on("response", captureDocumentResponse);
  try {
    response = await page.goto(url, { waitUntil: "domcontentloaded" });
  } catch (error) {
    if (!isNavigationRace(error) || page.url() === "about:blank") {
      page.off("response", captureDocumentResponse);
      throw error;
    }
    warning = error instanceof Error ? error.message : String(error);
  }
  await waitForNavigationToSettle(page);
  page.off("response", captureDocumentResponse);
  const finalResponse = response ?? latestDocumentResponse;
  return { ...(finalResponse ? { response: finalResponse } : {}), ...(warning ? { warning } : {}) };
}

async function clickResolvedReviewLink(page: Page, candidate: string): Promise<{ response?: PlaywrightResponse; warning?: string }> {
  const url = new URL(candidate);
  const absoluteHref = url.toString();
  const relativeHref = `${url.pathname}${url.search}${url.hash}`;
  const selector = `a[href='${absoluteHref}'], a[href='${relativeHref}']`;
  const links = page.locator(selector);
  const count = await links.count();
  let linkIndex = -1;
  for (let index = 0; index < count; index += 1) {
    if (await links.nth(index).isVisible().catch(() => false)) {
      linkIndex = index;
      break;
    }
  }
  if (linkIndex < 0) {
    return navigateStable(page, candidate);
  }

  let latestDocumentResponse: PlaywrightResponse | undefined;
  let warning: string | undefined;
  const captureDocumentResponse = (response: PlaywrightResponse) => {
    if (response.request().resourceType() === "document") latestDocumentResponse = response;
  };
  page.on("response", captureDocumentResponse);
  try {
    await links.nth(linkIndex).click({ timeout: 8_000 });
  } catch (error) {
    warning = error instanceof Error ? error.message : String(error);
    let reachedCandidate = page.url() === url.toString();
    try {
      const current = new URL(page.url());
      reachedCandidate ||= current.origin === url.origin && current.pathname === url.pathname;
    } catch {
      reachedCandidate = false;
    }
    if (!reachedCandidate) {
      page.off("response", captureDocumentResponse);
      const fallback = await navigateStable(page, candidate);
      return {
        ...fallback,
        warning: [warning, fallback.warning].filter(Boolean).join(" | "),
      };
    }
  }
  await waitForNavigationToSettle(page);
  page.off("response", captureDocumentResponse);
  return {
    ...(latestDocumentResponse ? { response: latestDocumentResponse } : {}),
    ...(warning ? { warning } : {}),
  };
}

async function pageState(page: Page): Promise<{ blocked: boolean; notFound: boolean; hasReviewContent: boolean; title: string; preview: string }> {
  let state: { title: string; text: string; iframeCount: number; elementCount: number; reviewMarkerCount: number } | undefined;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      state = await page.evaluate(() => ({
        title: document.title,
        text: document.body?.innerText.slice(0, 30_000) ?? "",
        iframeCount: document.querySelectorAll("iframe").length,
        elementCount: document.body?.querySelectorAll("*").length ?? 0,
        reviewMarkerCount: document.querySelectorAll("[data-service-review-card-paper], [itemprop='review'], [data-review-id], div[id^='survey-response-'], div.mb-6.p-6 h3.typo-20.font-semibold, [data-testid='textReview'], [id^='DetailedReview-']").length,
      }));
      break;
    } catch (error) {
      if (!isNavigationRace(error) || attempt === 5) throw error;
      await waitForNavigationToSettle(page);
      await page.waitForTimeout(250);
    }
  }
  if (!state) throw new Error("Chromium не смог прочитать DOM после цепочки редиректов.");
  const text = `${state.title}\n${state.text}`.toLowerCase();
  const blocked = [
    "verifying your connection",
    "verify you are human",
    "are you a human",
    "security verification",
    "access denied",
    "checking your browser",
    "just a moment",
  ].some((phrase) => text.includes(phrase)) || (state.iframeCount > 0 && state.elementCount < 25 && state.text.length < 500);
  const notFound = [
    "page not found",
    "we couldn't find",
    "we could not find",
    "doesn't exist",
    "does not exist",
    "we can’t find",
    "page you're looking for could not be found",
    "page you’re looking for could not be found",
    "404 error",
  ].some((phrase) => text.includes(phrase));
  return {
    blocked: blocked && state.reviewMarkerCount === 0,
    notFound,
    hasReviewContent: state.reviewMarkerCount > 0,
    title: state.title,
    preview: state.text.replace(/\s+/g, " ").trim().slice(0, 500),
  };
}

async function waitForChallenge(page: Page, initialState?: Awaited<ReturnType<typeof pageState>>): Promise<Awaited<ReturnType<typeof pageState>>> {
  let state = initialState ?? await pageState(page);
  const deadline = Date.now() + CHALLENGE_WAIT_MS;
  while (state.blocked && Date.now() < deadline) {
    await page.waitForTimeout(1_500);
    state = await pageState(page);
  }
  return state;
}

async function waitForManualCapterraChallenge(
  adapter: ReviewAdapter,
  page: Page,
  initialState: Awaited<ReturnType<typeof pageState>>,
  options?: ReviewScrapeOptions,
): Promise<{ state: Awaited<ReturnType<typeof pageState>>; attempted: boolean; solved: boolean }> {
  if (adapter.source !== "capterra" || !initialState.blocked || !options?.challengeOwnerId || !options.onChallengeChange) {
    return { state: initialState, attempted: false, solved: false };
  }

  const handle = registerReviewChallenge(options.challengeOwnerId, page);
  options.onChallengeChange(handle.challenge);
  let state = initialState;
  let solved = false;
  const deadline = Date.now() + MANUAL_CHALLENGE_WAIT_MS;
  try {
    while (Date.now() < deadline && !handle.isCancelled() && !page.isClosed()) {
      await page.waitForTimeout(900);
      state = await pageState(page);
      if (!state.blocked) {
        await waitForNavigationToSettle(page);
        state = await pageState(page);
        solved = !state.blocked;
        if (solved) break;
      }
    }
    return { state, attempted: true, solved };
  } finally {
    handle.close();
    options.onChallengeChange(undefined);
  }
}

async function resolveCapterraCandidates(page: Page, query: string): Promise<string[]> {
  const normalized = normalizeCompanyQuery(query);
  const keys = unique([normalized.slug, normalized.domain.replace(/\.[a-z]{2,}$/i, "")])
    .map((value) => value.replace(/[^a-z0-9]/g, ""));
  const reviewUrl = await page.evaluate(({ expectedKeys }) => {
    const normalize = (value: string) => value.toLowerCase().replace(/\blogo\b/g, "").replace(/[^a-z0-9]/g, "");
    const candidates = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='/p/']"))
      .map((anchor) => {
        const href = new URL(anchor.href, location.href);
        const match = href.pathname.match(/^\/p\/(\d+)\/([^/]+)\/?/i);
        if (!match) return undefined;
        const text = normalize(anchor.textContent || anchor.querySelector("img")?.getAttribute("alt") || "");
        const slug = normalize(match[2]);
        const exact = expectedKeys.some((key) => key && text === key);
        const slugMatch = expectedKeys.some((key) => key && slug === key);
        const partial = expectedKeys.some((key) => key && (text.includes(key) || slug.includes(key)));
        const score = exact ? 100 : slugMatch ? 90 : partial ? 40 : 0;
        return { score, url: `${href.origin}/p/${match[1]}/${match[2]}/reviews/` };
      })
      .filter((candidate): candidate is { score: number; url: string } => Boolean(candidate?.score))
      .sort((left, right) => right.score - left.score);
    return candidates[0]?.url;
  }, { expectedKeys: keys });
  return reviewUrl ? [reviewUrl] : [];
}

async function prepareCapterraReviews(page: Page): Promise<void> {
  const buttons = await page.getByRole("button", { name: "Continue reading", exact: true }).all();
  for (const button of buttons) {
    if (await button.isVisible().catch(() => false)) await button.click({ timeout: 2_000 }).catch(() => undefined);
  }
  if (buttons.length) await page.waitForTimeout(250);
}

async function extractCapterraReviews(page: Page, pageNumber: number): Promise<{ companyName?: string; reviews: UserReview[] }> {
  const raw = await page.evaluate(() => {
    const compact = (value?: string | null) => value?.replace(/\s+/g, " ").trim() ?? "";
    const headings = Array.from(document.querySelectorAll<HTMLHeadingElement>("h3.typo-20.font-semibold"));
    const cards = [...new Set(headings.map((heading) => {
      let current: Element | null = heading;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        if (current.querySelector("span.typo-20.text-neutral-99.font-semibold") && current.querySelector("span.sr2r3oj")) return current;
      }
      return heading.closest("div.mb-6.p-6");
    }).filter((card): card is Element => Boolean(card)))];
    const heading = compact(document.querySelector("h1")?.textContent);
    const companyName = heading
      .replace(/\s+(?:software\s+)?reviews?.*$/i, "")
      .replace(/\s+software\s+review.*$/i, "") || undefined;
    return {
      companyName,
      reviews: cards.map((card) => {
        const author = compact(card.querySelector("span.typo-20.text-neutral-99.font-semibold")?.textContent);
        const title = compact(card.querySelector("h3.typo-20.font-semibold")?.textContent).replace(/^[\"“]|[\"”]$/g, "");
        const date = compact(card.querySelector(".typo-0.text-neutral-90")?.textContent);
        const ratingText = compact(card.querySelector("span.sr2r3oj")?.textContent);
        const rating = Number(ratingText.match(/[0-5](?:[.,]\d+)?/)?.[0]?.replace(",", "."));
        const paragraphs = Array.from(card.querySelectorAll("p"))
          .map((paragraph) => compact(paragraph.textContent))
          .filter(Boolean);
        const text = [...new Set(paragraphs)].join("\n\n");
        return {
          author: author || "Анонимный пользователь",
          date: date || undefined,
          title: title || undefined,
          text,
          rating: Number.isFinite(rating) ? rating : undefined,
          reviewUrl: location.href,
        };
      }).filter((review) => Boolean(review.text || review.title)),
    };
  });

  return {
    companyName: raw.companyName,
    reviews: raw.reviews.map((review) => {
      const value: Omit<UserReview, "id"> = {
        source: "capterra",
        author: review.author,
        ...(review.date ? { date: review.date } : {}),
        ...(review.title ? { title: review.title } : {}),
        text: review.text,
        ...(review.rating !== undefined ? { rating: review.rating } : {}),
        maxRating: 5,
        reviewUrl: review.reviewUrl,
        page: pageNumber,
      };
      return { id: reviewId(value), ...value };
    }),
  };
}

async function resolveSoftwareAdviceCandidates(page: Page, query: string): Promise<string[]> {
  const normalized = normalizeCompanyQuery(query);
  const searchTerm = query.includes(".") ? normalized.slug : query.trim();
  const input = page.getByRole("textbox", { name: "Search for products or categories" });
  if (!await input.count()) return [];
  await input.fill(searchTerm);
  const options = page.locator("li > div.cursor-pointer");
  await options.first().waitFor({ state: "visible", timeout: 6_000 }).catch(() => undefined);
  const optionCount = await options.count();
  let bestIndex = -1;
  let bestScore = 0;
  for (let index = 0; index < optionCount; index += 1) {
    const option = options.nth(index);
    if (!await option.isVisible().catch(() => false)) continue;
    const label = (await option.locator("p").first().textContent().catch(() => ""))?.trim() ?? "";
    const score = scoreSoftwareAdviceResult(label, searchTerm);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  if (bestIndex < 0) return [];

  const selectedOption = options.nth(bestIndex);
  await selectedOption.scrollIntoViewIfNeeded().catch(() => undefined);
  await selectedOption.click({ timeout: 8_000 });
  await page.waitForURL((url) => isSoftwareAdviceProfileUrl(url.toString()), { timeout: 12_000 }).catch(() => undefined);

  await waitForNavigationToSettle(page);
  await page.waitForTimeout(500);
  if (!isSoftwareAdviceProfileUrl(page.url())) return [];
  const profileUrl = new URL(page.url());
  const basePath = profileUrl.pathname.endsWith("/") ? profileUrl.pathname : `${profileUrl.pathname}/`;
  const reviewsUrl = await page.evaluate(({ expectedPath }) => {
    const link = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .find((anchor) => new URL(anchor.href, location.href).pathname === `${expectedPath}reviews/`);
    return link ? new URL(link.href, location.href).toString() : undefined;
  }, { expectedPath: basePath });
  return [reviewsUrl ?? `${profileUrl.origin}${basePath}reviews/`];
}

async function prepareSoftwareAdviceReviews(page: Page): Promise<void> {
  const expanded = await page.evaluate(() => {
    let count = 0;
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='textReview']"));
    for (const card of cards) {
      const label = Array.from(card.querySelectorAll<HTMLElement>("p, button, [role='button']"))
        .find((element) => element.textContent?.trim() === "Read More");
      const control = label?.closest<HTMLElement>(".cursor-pointer, button, [role='button']") ?? label;
      if (!control || control.getClientRects().length === 0) continue;
      control.click();
      count += 1;
    }
    return count;
  }).catch(() => 0);
  if (expanded) await page.waitForTimeout(250);
}

async function prepareProductHuntReviews(page: Page): Promise<void> {
  const cards = page.locator("[id^='DetailedReview-']");
  const count = await cards.count();
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    const controls = await cards.nth(index).getByRole("button", { name: "Read more", exact: true }).all();
    for (const control of controls) {
      if (!await control.isVisible().catch(() => false)) continue;
      await control.click({ timeout: 3_000 }).catch(() => undefined);
      expanded += 1;
    }
  }
  if (expanded) await page.waitForTimeout(250);
}

async function advanceSoftwareAdvicePage(page: Page): Promise<boolean> {
  const next = page.getByRole("button", { name: "Next", exact: true });
  if (!await next.count() || !await next.isVisible().catch(() => false) || !await next.isEnabled().catch(() => false)) return false;
  const pageStatus = page.getByText(/^Showing \d+\s*-\s*\d+ of \d+ Reviews$/).last();
  const before = await pageStatus.textContent().catch(() => "");
  await next.click({ timeout: 5_000 }).catch(() => undefined);
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(350);
    const after = await pageStatus.textContent().catch(() => "");
    if (after && after !== before) return true;
  }
  return false;
}

async function extractSoftwareAdviceReviews(page: Page, pageNumber: number): Promise<{ companyName?: string; reviews: UserReview[] }> {
  const raw = await page.evaluate(() => {
    const compact = (value?: string | null) => value?.replace(/\s+/g, " ").trim() ?? "";
    const heading = compact(document.querySelector("h1")?.textContent);
    const companyName = heading
      .replace(/\s+(?:software\s+)?reviews?.*$/i, "")
      .replace(/\s+review$/i, "") || undefined;
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='textReview']"));
    return {
      companyName,
      reviews: cards.map((card) => {
        const author = compact(card.querySelector("[data-testid='reviewer-first-name']")?.textContent);
        const dateElement = card.querySelector("[data-testid='reviewed-date']");
        const date = compact(dateElement?.textContent).replace(/^Reviewed\s+/i, "");
        const title = compact(dateElement?.nextElementSibling?.textContent);
        const ratingText = compact(card.querySelector("[data-testid='review-overall-rating-value']")?.textContent);
        const rating = Number(ratingText.match(/[0-5](?:[.,]\d+)?/)?.[0]?.replace(",", "."));
        const content = dateElement?.parentElement;
        const overview = Array.from(content?.querySelectorAll<HTMLParagraphElement>("p.text-sm.text-grey-91:not([data-testid])") ?? [])
          .map((paragraph) => compact(paragraph.textContent))
          .find(Boolean);
        const pros = compact(card.querySelector("[data-testid='review-pros-text']")?.textContent);
        const cons = compact(card.querySelector("[data-testid='review-cons-text']")?.textContent);
        const text = [overview, pros ? `Плюсы: ${pros}` : "", cons ? `Минусы: ${cons}` : ""].filter(Boolean).join("\n\n");
        return {
          author: author || "Анонимный пользователь",
          date: date || undefined,
          title: title || undefined,
          text,
          rating: Number.isFinite(rating) ? rating : undefined,
          reviewUrl: location.href,
        };
      }).filter((review) => Boolean(review.text || review.title)),
    };
  });

  return {
    companyName: raw.companyName,
    reviews: raw.reviews.map((review) => {
      const value: Omit<UserReview, "id"> = {
        source: "softwareadvice",
        author: review.author,
        ...(review.date ? { date: review.date } : {}),
        ...(review.title ? { title: review.title } : {}),
        text: review.text,
        ...(review.rating !== undefined ? { rating: review.rating } : {}),
        maxRating: 5,
        reviewUrl: review.reviewUrl,
        page: pageNumber,
      };
      return { id: reviewId(value), ...value };
    }),
  };
}

async function extractProductHuntReviews(page: Page, pageNumber: number): Promise<{ companyName?: string; reviews: UserReview[] }> {
  const raw = await page.evaluate(() => {
    const compact = (value?: string | null) => value?.replace(/\s+/g, " ").trim() ?? "";
    const companyName = compact(document.querySelector("h1")?.textContent).replace(/\s+Reviews?$/i, "") || undefined;
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[id^='DetailedReview-']"));
    return {
      companyName,
      reviews: cards.map((card) => {
        const authorLink = card.querySelector<HTMLAnchorElement>("a[href^='/@']");
        const author = compact(authorLink?.textContent);
        const time = card.querySelector<HTMLTimeElement>("time");
        const date = time?.dateTime || compact(time?.textContent) || undefined;
        const ratingGroup = card.querySelector("label[data-test='star-1-readonly']")?.parentElement;
        const rating = ratingGroup?.querySelectorAll("svg[data-test$='-filled']").length;
        const sections = Array.from(card.querySelectorAll<HTMLElement>("div.prose.prose-sm"))
          .map((block) => {
            const text = compact(block.textContent);
            if (!text) return "";
            const heading = compact(block.parentElement?.querySelector(":scope > h4")?.textContent);
            return heading ? `${heading}:\n${text}` : text;
          })
          .filter(Boolean);
        const text = [...new Set(sections)].join("\n\n");
        return {
          id: card.id,
          author: author || "Anonymous user",
          date,
          text,
          rating: typeof rating === "number" && rating > 0 ? rating : undefined,
          reviewUrl: card.id ? `${location.origin}${location.pathname}${location.search}#${card.id}` : location.href,
        };
      }).filter((review) => Boolean(review.text)),
    };
  });

  return {
    companyName: raw.companyName,
    reviews: raw.reviews.map((review) => {
      const value: Omit<UserReview, "id"> = {
        source: "producthunt",
        author: review.author,
        ...(review.date ? { date: review.date } : {}),
        text: review.text,
        ...(review.rating !== undefined ? { rating: review.rating } : {}),
        maxRating: 5,
        reviewUrl: review.reviewUrl,
        page: pageNumber,
      };
      return { id: review.id.replace(/^DetailedReview-/, "") || reviewId(value), ...value };
    }),
  };
}

async function extractReviews(page: Page, source: ReviewSource, pageNumber: number): Promise<{ companyName?: string; reviews: UserReview[] }> {
  const raw = await page.evaluate(({ currentSource }) => {
    const compact = (value?: string | null) => value?.replace(/\s+/g, " ").trim() ?? "";
    const first = (root: Element, selectors: string[]): Element | null => {
      for (const selector of selectors) {
        const match = root.querySelector(selector);
        if (match) return match;
      }
      return null;
    };
    const textOf = (root: Element, selectors: string[]): string => compact(first(root, selectors)?.textContent);
    const cardSelectors = currentSource === "trustpilot"
      ? ["article[data-service-review-card-paper]", "[data-service-review-card-paper]"]
      : ["[itemprop='review']", "[data-review-id]", "div[id^='survey-response-']"];
    let cards: Element[] = [];
    for (const selector of cardSelectors) {
      cards = Array.from(document.querySelectorAll(selector));
      if (cards.length) break;
    }
    const companyName = compact(document.querySelector("h1")?.textContent)
      .replace(/\s+reviews.*$/i, "") || undefined;
    return {
      companyName,
      reviews: cards.map((card) => {
        const authorElement = first(card, currentSource === "trustpilot"
          ? ["[data-consumer-name-typography]", "[data-consumer-name]", "[rel='nofollow']"]
          : ["[itemprop='author']", "[itemprop='name']", "[class*='user-name']", "[class*='reviewer']"]);
        const dateElement = first(card, ["time", "[itemprop='datePublished']", "[data-service-review-date-time-ago]"]);
        const ratingElement = first(card, currentSource === "trustpilot"
          ? ["[data-service-review-rating]", "img[alt*='out of 5']", "img[alt*='star']"]
          : ["[itemprop='ratingValue']", "[aria-label*='out of 5']", "[aria-label*='star']", "[class*='stars']"]);
        const title = textOf(card, currentSource === "trustpilot"
          ? ["[data-service-review-title-typography]", "h2", "h3"]
          : ["[itemprop='name']", "h3", "h4", "[class*='review-title']"]);
        const text = textOf(card, currentSource === "trustpilot"
          ? ["[data-service-review-text-typography]", "[data-service-review-text]", "p"]
          : ["[itemprop='reviewBody']", "[class*='review-content']", "[class*='formatted-text']", "p"]);
        const ratingRaw = [
          ratingElement?.getAttribute("content"),
          ratingElement?.getAttribute("data-service-review-rating"),
          ratingElement?.getAttribute("aria-label"),
          ratingElement?.getAttribute("alt"),
          ratingElement?.textContent,
        ].filter(Boolean).join(" ");
        const rating = Number(ratingRaw.match(/(?:^|\D)([0-5](?:[.,]\d)?)(?:\s*\/\s*5|\s*out of\s*5|\s*star|$)/i)?.[1]?.replace(",", "."));
        const link = first(card, ["a[href*='/reviews/']", "a[href*='/review/']", "a[href]"])?.getAttribute("href") ?? "";
        const date = dateElement?.getAttribute("datetime") || dateElement?.getAttribute("content") || compact(dateElement?.textContent);
        return {
          author: compact(authorElement?.textContent) || "Анонимный пользователь",
          date: date || undefined,
          title: title || undefined,
          text,
          rating: Number.isFinite(rating) ? rating : undefined,
          reviewUrl: link ? new URL(link, location.href).toString() : undefined,
        };
      }).filter((review) => Boolean(review.text || review.title)),
    };
  }, { currentSource: source });

  return {
    companyName: raw.companyName,
    reviews: raw.reviews.map((review) => {
      const value: Omit<UserReview, "id"> = {
        source,
        author: review.author,
        ...(review.date ? { date: review.date } : {}),
        ...(review.title ? { title: review.title } : {}),
        text: review.text,
        ...(review.rating !== undefined ? { rating: review.rating } : {}),
        maxRating: 5,
        ...(review.reviewUrl ? { reviewUrl: review.reviewUrl } : {}),
        page: pageNumber,
      };
      return { id: reviewId(value), ...value };
    }),
  };
}

const adapters: Record<ReviewSource, ReviewAdapter> = {
  trustpilot: {
    source: "trustpilot",
    label: "Trustpilot",
    buildCandidates: buildTrustpilotCandidates,
    extract: (page, pageNumber) => extractReviews(page, "trustpilot", pageNumber),
  },
  capterra: {
    source: "capterra",
    label: "Capterra",
    buildCandidates: buildCapterraCandidates,
    resolveCandidates: resolveCapterraCandidates,
    openResolvedCandidate: clickResolvedReviewLink,
    prepare: prepareCapterraReviews,
    extract: extractCapterraReviews,
  },
  softwareadvice: {
    source: "softwareadvice",
    label: "Software Advice",
    buildCandidates: buildSoftwareAdviceCandidates,
    resolveCandidates: resolveSoftwareAdviceCandidates,
    openResolvedCandidate: clickResolvedReviewLink,
    advancePage: advanceSoftwareAdvicePage,
    prepare: prepareSoftwareAdviceReviews,
    extract: extractSoftwareAdviceReviews,
  },
  producthunt: {
    source: "producthunt",
    label: "Product Hunt",
    buildCandidates: buildProductHuntCandidates,
    prepare: prepareProductHuntReviews,
    extract: extractProductHuntReviews,
  },
};

async function createContext(proxySettings?: ReviewProxyCredentials): Promise<{ context: BrowserContext; browser: ReviewBrowserInfo; close: () => Promise<void> }> {
  const browser = await getMetaBrowser();
  const rawVersion = browser.version();
  const version = rawVersion.match(/\d+(?:\.\d+){1,3}/)?.[0] ?? rawVersion;
  const majorVersion = version.match(/^\d+/)?.[0] ?? "126";
  const userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  const proxyServer = proxySettings?.server;
  if (proxyServer && !/^(?:https?|socks5):\/\/[^\s]+$/i.test(proxyServer)) {
    throw new AppError(
      500,
      "REVIEW_PROXY_INVALID",
      "Некорректный REVIEW_PROXY_SERVER.",
      "Укажите адрес вместе с протоколом, например http://host:port или socks5://host:port.",
    );
  }
  let bridge: SocksProxyBridge | undefined;
  const needsSocksAuthBridge = Boolean(proxyServer?.toLowerCase().startsWith("socks5://") && (proxySettings?.username || proxySettings?.password));
  if (proxyServer && needsSocksAuthBridge) {
    bridge = await createAuthenticatedSocks5Bridge(proxyServer, proxySettings?.username, proxySettings?.password);
  }
  const proxy = proxyServer ? {
    server: bridge?.server ?? proxyServer,
    ...(!bridge && proxySettings?.username ? { username: proxySettings.username } : {}),
    ...(!bridge && proxySettings?.password ? { password: proxySettings.password } : {}),
    ...(proxySettings?.bypass ? { bypass: proxySettings.bypass } : {}),
  } : undefined;
  let context: BrowserContext;
  try {
    context = await browser.newContext({
      viewport: { width: 1440, height: 1_000 },
      screen: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      colorScheme: "light",
      locale: "en-US",
      timezoneId: "UTC",
      userAgent,
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        "sec-ch-ua": `"Chromium";v="${majorVersion}", "Not_A Brand";v="99"`,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"Linux\"",
      },
      ...(proxy ? { proxy } : {}),
    });
  } catch (error) {
    await bridge?.close();
    throw error;
  }
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });
  let proxyLabel: string | undefined;
  if (proxyServer) {
    const parsed = new URL(proxyServer);
    parsed.username = "";
    parsed.password = "";
    proxyLabel = parsed.toString().replace(/\/$/, "");
  }
  return {
    context,
    browser: { version, userAgent, ...(proxyLabel ? { proxy: proxyLabel } : {}) },
    close: async () => {
      try {
        await context.close();
      } finally {
        await bridge?.close();
      }
    },
  };
}

export async function testReviewProxyConnection(proxySettings?: ReviewProxyCredentials): Promise<ReviewProxyTestResult> {
  if (!proxySettings?.server) {
    throw new AppError(400, "REVIEW_PROXY_NOT_CONFIGURED", "Сначала сохраните настройки прокси.");
  }
  const startedAt = Date.now();
  const logs: ReviewProxyTestLog[] = [];
  let context: BrowserContext | undefined;
  let closeContext: (() => Promise<void>) | undefined;
  let browserInfo: ReviewBrowserInfo | undefined;
  const proxyLabel = (() => {
    try {
      const parsed = new URL(proxySettings.server);
      parsed.username = "";
      parsed.password = "";
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return proxySettings.server.replace(/\/\/[^/@]+@/, "//");
    }
  })();
  const redact = (value: string): string => {
    let result = value;
    for (const secret of [proxySettings.password, proxySettings.username].filter(Boolean)) {
      result = result.replaceAll(secret as string, "***");
    }
    return result.replace(/\/\/[^\s/@:]+:[^\s/@]+@/g, "//***:***@");
  };
  const addLog = (
    stage: ReviewProxyTestLog["stage"],
    status: ReviewProxyTestLog["status"],
    message: string,
    details?: ReviewProxyTestLog["details"],
  ) => {
    logs.push({
      stage,
      status,
      message: redact(message),
      elapsedMs: Date.now() - startedAt,
      ...(details ? { details } : {}),
    });
  };

  addLog("proxy", "started", "Настройки прокси получены сервером.", {
    proxy: proxyLabel,
    authentication: Boolean(proxySettings.username || proxySettings.password),
    socksAuthBridge: Boolean(proxySettings.server.toLowerCase().startsWith("socks5://") && (proxySettings.username || proxySettings.password)),
    bypass: Boolean(proxySettings.bypass),
  });
  try {
    addLog("browser", "started", "Запускаем изолированный контекст Chromium через прокси.");
    const created = await createContext(proxySettings);
    context = created.context;
    closeContext = created.close;
    browserInfo = created.browser;
    addLog("browser", "success", `Chromium ${created.browser.version} запущен.`, {
      version: created.browser.version,
      userAgent: created.browser.userAgent,
    });

    const page = await context.newPage();
    const targetUrl = "https://api.ipify.org?format=json";
    addLog("request", "started", "Отправляем контрольный HTTPS-запрос через прокси.", { url: targetUrl, timeoutMs: 25_000 });
    const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });
    const raw = await page.textContent("body");
    let externalIp: string | undefined;
    try {
      const parsed = JSON.parse(raw ?? "{}") as { ip?: unknown };
      if (typeof parsed.ip === "string") externalIp = parsed.ip;
    } catch {
      externalIp = raw?.trim().match(/(?:\d{1,3}\.){3}\d{1,3}|[a-f0-9:]{3,}/i)?.[0];
    }
    const ok = Boolean(response?.ok() && externalIp);
    addLog("response", ok ? "success" : "error", ok
      ? `Контрольный сервис подтвердил внешний IP ${externalIp}.`
      : `Контрольный сервис не подтвердил соединение: HTTP ${response?.status() ?? "без ответа"}.`, {
      httpStatus: response?.status() ?? 0,
      finalUrl: page.url(),
      responsePreview: redact((raw ?? "").replace(/\s+/g, " ").trim().slice(0, 300)),
    });
    return {
      ok,
      ...(externalIp ? { externalIp } : {}),
      elapsedMs: Date.now() - startedAt,
      message: ok ? "Соединение через прокси установлено." : `Прокси вернула HTTP ${response?.status() ?? "без ответа"}.`,
      proxy: proxyLabel,
      ...(browserInfo ? { browserVersion: browserInfo.version, userAgent: browserInfo.userAgent } : {}),
      logs,
    };
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    addLog(context ? "request" : "browser", "error", message, {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      message: "Не удалось установить соединение через прокси.",
      proxy: proxyLabel,
      ...(browserInfo ? { browserVersion: browserInfo.version, userAgent: browserInfo.userAgent } : {}),
      logs,
    };
  } finally {
    if (closeContext) {
      try {
        await closeContext();
        addLog("cleanup", "success", "Контекст Chromium закрыт.");
      } catch (error) {
        addLog("cleanup", "error", error instanceof Error ? error.message : String(error));
      }
    }
  }
}

async function scrapeSource(adapter: ReviewAdapter, query: string, proxySettings?: ReviewProxyCredentials, options?: ReviewScrapeOptions): Promise<ReviewSourceResult> {
  let candidates = adapter.buildCandidates(query);
  let resolvedCandidatePage: Page | undefined;
  const attemptedUrls: string[] = [];
  const attempts: ReviewAttemptLog[] = [];
  const activity = (stage: string, message: string, details?: Omit<ReviewProgressOperation, "stage" | "message" | "at" | "elapsedMs">) => {
    options?.onActivity?.({ stage, message, ...details });
  };
  activity("browser_start", "Запускаем отдельный Chromium и подключаем прокси.");
  const created = await createContext(proxySettings);
  const { context, browser } = created;
  activity("browser_ready", `Chromium ${browser.version} запущен.`, { url: candidates[0] });
  const record = (attempt: ReviewAttemptLog) => {
    attempts.push(attempt);
    console.info(`[review-analysis:${adapter.source}]`, JSON.stringify(attempt));
  };
  try {
    let lastError = "";
    if (adapter.resolveCandidates) {
      const searchUrl = candidates[0];
      const searchPage = await context.newPage();
      let keepSearchPage = false;
      searchPage.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      attemptedUrls.push(searchUrl);
      const searchStartedAt = Date.now();
      try {
        activity("search_open", `Открываем поиск ${adapter.label}.`, { url: searchUrl });
        const navigation = await navigateStable(searchPage, searchUrl);
        const response = navigation.response;
        await searchPage.waitForTimeout(700);
        activity("access_check", `Страница поиска загружена${response ? `: HTTP ${response.status()}` : ""}. Проверяем защиту.`, { url: searchPage.url() });
        const initialState = await pageState(searchPage);
        let state = initialState.notFound || adapter.source === "capterra" ? initialState : await waitForChallenge(searchPage, initialState);
        const initialBlockedByStatus = response ? [401, 403, 429].includes(response.status()) && !state.notFound : false;
        const manualChallenge = await waitForManualCapterraChallenge(adapter, searchPage, state, options);
        state = manualChallenge.state;
        const blockedByStatus = initialBlockedByStatus && !manualChallenge.solved;
        if (state.blocked || blockedByStatus) {
          record({
            url: searchUrl,
            finalUrl: searchPage.url(),
            httpStatus: response?.status(),
            title: state.title,
            outcome: "blocked",
            durationMs: Date.now() - searchStartedAt,
            pagePreview: state.preview,
            message: manualChallenge.attempted
              ? "Ручная проверка Cloudflare не была завершена за 5 минут или была отменена."
              : blockedByStatus
              ? `Источник вернул HTTP ${response?.status()} при поиске компании.`
              : `JS-проверка не завершилась за ${Math.round(CHALLENGE_WAIT_MS / 1_000)} секунд.`,
          });
          return {
            source: adapter.source,
            label: adapter.label,
            status: "blocked",
            query,
            profileUrl: searchPage.url(),
            attemptedUrls,
            attempts,
            browser,
            reviews: [],
            message: `${adapter.label} не отдала страницу поиска серверу. Подробности находятся в логе Chromium ниже.`,
          };
        }
        activity("profile_search", `Ищем точный профиль «${query}» в ${adapter.label}.`, { url: searchPage.url() });
        candidates = response?.status() === 404 || state.notFound ? [] : await adapter.resolveCandidates(searchPage, query);
        activity(candidates.length ? "profile_found" : "profile_not_found", candidates.length
          ? `Профиль найден: ${candidates[0]}`
          : "Подходящий профиль не найден.", candidates.length ? { url: candidates[0] } : undefined);
        if (candidates.length && adapter.openResolvedCandidate) {
          resolvedCandidatePage = searchPage;
          keepSearchPage = true;
        }
        record({
          url: searchUrl,
          finalUrl: searchPage.url(),
          httpStatus: response?.status(),
          title: state.title,
          outcome: candidates.length ? "found" : "not_found",
          durationMs: Date.now() - searchStartedAt,
          pagePreview: state.preview,
          message: candidates.length
            ? `Найден профиль компании: ${candidates[0]}`
            : "Точный профиль компании не найден в результатах поиска.",
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        activity("search_error", `Ошибка поиска профиля: ${lastError}`, { url: searchPage.url() });
        record({
          url: searchUrl,
          finalUrl: searchPage.url(),
          outcome: "error",
          durationMs: Date.now() - searchStartedAt,
          message: lastError,
        });
        candidates = [];
      } finally {
        if (!keepSearchPage) await searchPage.close().catch(() => undefined);
      }
      if (!candidates.length) {
        return {
          source: adapter.source,
          label: adapter.label,
          status: lastError ? "error" : "not_found",
          query,
          attemptedUrls,
          attempts,
          browser,
          reviews: [],
          message: lastError || `Компания не найдена через поиск ${adapter.label}.`,
        };
      }
    }
    for (const candidate of candidates) {
      const page = resolvedCandidatePage ?? await context.newPage();
      const shouldOpenFromResolvedPage = page === resolvedCandidatePage && Boolean(adapter.openResolvedCandidate);
      resolvedCandidatePage = undefined;
      page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      attemptedUrls.push(candidate);
      const startedAt = Date.now();
      try {
        activity("profile_open", `Открываем страницу отзывов ${adapter.label}.`, { url: candidate });
        const navigation = shouldOpenFromResolvedPage
          ? await adapter.openResolvedCandidate!(page, candidate)
          : await navigateStable(page, candidate);
        const response = navigation.response;
        await page.waitForTimeout(700);
        activity("access_check", `Страница загружена${response ? `: HTTP ${response.status()}` : ""}. Проверяем доступ и наличие отзывов.`, { url: page.url() });
        const initialState = await pageState(page);
        let state = initialState.notFound || initialState.hasReviewContent || adapter.source === "capterra" ? initialState : await waitForChallenge(page, initialState);
        const initialBlockedByStatus = response ? [401, 403, 429].includes(response.status()) && !state.notFound && !state.hasReviewContent : false;
        const manualChallenge = await waitForManualCapterraChallenge(adapter, page, state, options);
        state = manualChallenge.state;
        const blockedByStatus = initialBlockedByStatus && !manualChallenge.solved;
        const firstAttempt: ReviewAttemptLog = {
          url: candidate,
          finalUrl: page.url(),
          httpStatus: response?.status(),
          title: state.title,
          outcome: response?.status() === 404 || state.notFound ? "not_found" : state.blocked || blockedByStatus ? "blocked" : "loaded",
          durationMs: Date.now() - startedAt,
          pagePreview: state.preview,
          ...(navigation.warning
            ? { message: `Chromium обработал автоматический редирект: ${navigation.warning}` }
            : shouldOpenFromResolvedPage
              ? { message: `Переход выполнен кликом из результатов поиска ${adapter.label} в той же вкладке.` }
              : {}),
        };
        if (response?.status() === 404 || state.notFound) {
          activity("profile_not_found", "Страница профиля не найдена, проверяем следующий вариант.", { url: page.url() });
          record(firstAttempt);
          continue;
        }
        if (state.blocked || blockedByStatus) {
          firstAttempt.message = manualChallenge.attempted
            ? "Ручная проверка Cloudflare не была завершена за 5 минут или была отменена."
            : blockedByStatus
            ? `Источник вернул HTTP ${response?.status()} для IP сервера.`
            : `JS-проверка не завершилась за ${Math.round(CHALLENGE_WAIT_MS / 1_000)} секунд.`;
          activity("access_blocked", firstAttempt.message, { url: page.url() });
          record(firstAttempt);
          return {
            source: adapter.source,
            label: adapter.label,
            status: "blocked",
            query,
            profileUrl: page.url(),
            attemptedUrls,
            attempts,
            browser,
            reviews: [],
            message: blockedByStatus
              ? `${adapter.label} вернул HTTP ${response?.status()} для IP сервера. Подробности находятся в логе Chromium ниже.`
              : `${adapter.label} не завершил проверку браузера за ${Math.round(CHALLENGE_WAIT_MS / 1_000)} секунд. Подробности находятся в логе Chromium ниже.`,
          };
        }
        const allReviews: UserReview[] = [];
        let companyName: string | undefined;
        let profileUrl = page.url();
        for (let currentPage = 1; currentPage <= MAX_PAGES; currentPage += 1) {
          const target = adapter.advancePage && currentPage > 1
            ? `${candidate.replace(/#.*$/, "")}#page-${currentPage}`
            : pageUrl(candidate, currentPage);
          let currentAttempt = firstAttempt;
          if (currentPage > 1) {
            activity("page_open", `Открываем страницу ${currentPage} из ${MAX_PAGES}.`, { page: currentPage, reviewsFound: allReviews.length, url: target });
            attemptedUrls.push(target);
            const pageStartedAt = Date.now();
            const nextNavigation = adapter.advancePage
              ? { advanced: await adapter.advancePage(page, currentPage) }
              : { advanced: true, ...await navigateStable(page, target) };
            if (!nextNavigation.advanced) {
              currentAttempt = {
                url: target,
                finalUrl: page.url(),
                title: await page.title().catch(() => undefined),
                outcome: "not_found",
                durationMs: Date.now() - pageStartedAt,
                message: `Страница ${currentPage} отсутствует или кнопка перехода больше недоступна.`,
              };
              activity("pagination_end", `Страница ${currentPage} недоступна — сбор источника завершён.`, { page: currentPage, reviewsFound: allReviews.length, url: page.url() });
              record(currentAttempt);
              break;
            }
            const nextResponse = "response" in nextNavigation ? nextNavigation.response : undefined;
            await page.waitForTimeout(700);
            const initialNextState = await pageState(page);
            let nextState = initialNextState.notFound || initialNextState.hasReviewContent || adapter.source === "capterra" ? initialNextState : await waitForChallenge(page, initialNextState);
            const initialNextBlockedByStatus = nextResponse ? [401, 403, 429].includes(nextResponse.status()) && !nextState.notFound && !nextState.hasReviewContent : false;
            const nextManualChallenge = await waitForManualCapterraChallenge(adapter, page, nextState, options);
            nextState = nextManualChallenge.state;
            const nextBlockedByStatus = initialNextBlockedByStatus && !nextManualChallenge.solved;
            currentAttempt = {
              url: target,
              finalUrl: page.url(),
              httpStatus: nextResponse?.status(),
              title: nextState.title,
              outcome: nextResponse?.status() === 404 || nextState.notFound ? "not_found" : nextState.blocked || nextBlockedByStatus ? "blocked" : "loaded",
              durationMs: Date.now() - pageStartedAt,
              pagePreview: nextState.preview,
              ...("warning" in nextNavigation && nextNavigation.warning ? { message: `Chromium обработал автоматический редирект: ${nextNavigation.warning}` } : {}),
            };
            if (nextState.blocked || nextBlockedByStatus || nextResponse?.status() === 404 || nextState.notFound) {
              currentAttempt.message = nextManualChallenge.attempted
                ? "Ручная проверка Cloudflare не была завершена за 5 минут или была отменена."
                : nextBlockedByStatus
                ? `Источник вернул HTTP ${nextResponse?.status()} для IP сервера.`
                : nextState.blocked
                  ? `JS-проверка не завершилась за ${Math.round(CHALLENGE_WAIT_MS / 1_000)} секунд.`
                  : `Страница ${currentPage} не найдена.`;
              record(currentAttempt);
              break;
            }
          }
          const extractionStartedAt = Date.now();
          activity("reviews_expand", `Страница ${currentPage}: раскрываем полный текст отзывов.`, { page: currentPage, reviewsFound: allReviews.length, url: page.url() });
          await adapter.prepare?.(page);
          activity("reviews_extract", `Страница ${currentPage}: читаем карточки из DOM.`, { page: currentPage, reviewsFound: allReviews.length, url: page.url() });
          const extracted = await adapter.extract(page, currentPage);
          const knownReviewIds = new Set(allReviews.map((review) => review.id));
          const newReviews = extracted.reviews.filter((review) => {
            if (knownReviewIds.has(review.id)) return false;
            knownReviewIds.add(review.id);
            return true;
          });
          companyName ||= extracted.companyName;
          allReviews.push(...newReviews);
          currentAttempt.reviewsFound = newReviews.length;
          currentAttempt.outcome = newReviews.length ? "found" : "empty";
          currentAttempt.durationMs += Date.now() - extractionStartedAt;
          if (!extracted.reviews.length) {
            currentAttempt.message = "Страница открылась, но подходящие карточки отзывов в DOM не найдены.";
          } else if (!newReviews.length) {
            currentAttempt.message = "Страница повторяет уже собранные отзывы — дальнейший обход остановлен.";
          }
          record(currentAttempt);
          activity(newReviews.length ? "page_complete" : "page_empty", newReviews.length
            ? `Страница ${currentPage} готова: +${newReviews.length}, всего ${allReviews.length} отзывов.`
            : `На странице ${currentPage} новых отзывов нет — сбор источника завершён.`, {
            page: currentPage,
            reviewsFound: allReviews.length,
            url: page.url(),
          });
          if (!newReviews.length) break;
        }
        const reviews = deduplicateReviews(allReviews);
        if (!reviews.length) {
          lastError = `Страница ${adapter.label} открылась, но отзывы не найдены в текущей разметке.`;
          activity("no_reviews", lastError, { url: page.url() });
          continue;
        }
        activity("source_complete", `${adapter.label}: собрано ${reviews.length} отзывов.`, {
          reviewsFound: reviews.length,
          page: reviews.reduce((maximum, review) => Math.max(maximum, review.page), 0),
          url: profileUrl,
        });
        return {
          source: adapter.source,
          label: adapter.label,
          status: "found",
          query,
          companyName,
          profileUrl,
          attemptedUrls,
          attempts,
          browser,
          reviews,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        activity("candidate_error", `Ошибка обработки страницы: ${lastError}`, { url: page.url() });
        record({
          url: candidate,
          finalUrl: page.url(),
          outcome: "error",
          durationMs: Date.now() - startedAt,
          message: lastError,
        });
      } finally {
        await page.close().catch(() => undefined);
      }
    }
    return {
      source: adapter.source,
      label: adapter.label,
      status: lastError ? "error" : "not_found",
      query,
      attemptedUrls,
      attempts,
      browser,
      reviews: [],
      message: lastError || `Компания не найдена в ${adapter.label} ни по одному варианту адреса.`,
    };
  } finally {
    await created.close();
  }
}

export function shouldRetryReviewSource(result: Pick<ReviewSourceResult, "status">): boolean {
  return result.status === "error" || result.status === "blocked";
}

export async function searchCompanyReviews(
  query: string,
  sources: ReviewSource[],
  proxySettings?: ReviewProxyCredentials,
  onProgress?: (progress: ReviewSourceProgress) => void,
  challengeOwnerId?: string,
): Promise<ReviewSearchResponse> {
  const results = new Map<ReviewSource, ReviewSourceResult>();
  const operationsBySource = new Map<ReviewSource, ReviewProgressOperation[]>();

  const runSource = async (source: ReviewSource, attemptNumber: 1 | 2): Promise<ReviewSourceResult> => {
    const adapter = adapters[source];
    const sourceStartedAt = Date.now();
    const operations = operationsBySource.get(source) ?? [];
    operationsBySource.set(source, operations);
    let activeChallenge: ReviewManualChallenge | undefined;
    const reportActivity = (activity: Omit<ReviewProgressOperation, "at" | "elapsedMs">) => {
      const operation: ReviewProgressOperation = {
        ...activity,
        attempt: attemptNumber,
        at: new Date().toISOString(),
        elapsedMs: Date.now() - sourceStartedAt,
      };
      operations.push(operation);
      onProgress?.({
        source,
        label: adapter.label,
        status: "running",
        activity: operation.message,
        attempt: attemptNumber,
        ...(operation.page !== undefined ? { currentPage: operation.page } : {}),
        ...(operation.reviewsFound !== undefined ? { reviewsFound: operation.reviewsFound } : {}),
        ...(activeChallenge ? { challenge: activeChallenge } : {}),
        operations: [...operations],
      });
    };
    reportActivity({
      stage: attemptNumber === 1 ? "initial_attempt" : "retry_attempt",
      message: attemptNumber === 1
        ? "Подготавливаем сборщик. Попытка 1 из 2."
        : "Повторная попытка 2 из 2 после завершения остальных источников.",
    });
    let result: ReviewSourceResult;
    try {
      result = await scrapeSource(adapter, query, proxySettings, {
        challengeOwnerId,
        onActivity: reportActivity,
        onChallengeChange: (challenge) => {
          activeChallenge = challenge;
          reportActivity({
            stage: challenge ? "manual_verification" : "manual_verification_complete",
            message: challenge
              ? "Cloudflare ждёт ручного подтверждения в окне Chromium."
              : "Ручная проверка завершена, продолжаем сбор.",
            ...(challenge ? { url: challenge.pageUrl } : {}),
          });
        },
      });
    } catch (error) {
      result = {
        source,
        label: adapter.label,
        status: "error" as const,
        query,
        attemptedUrls: adapter.buildCandidates(query),
        attempts: [],
        reviews: [],
        message: error instanceof Error ? error.message : "Неизвестная ошибка браузерного сбора.",
      };
    }
    const needsRetry = attemptNumber === 1 && (result.status === "error" || result.status === "blocked");
    const finalActivity = needsRetry
      ? `${result.message || "Источник завершился с ошибкой."} Повторим после завершения остальных источников.`
      : result.status === "found"
      ? `Готово: собрано ${result.reviews.length} отзывов.`
      : result.message || "Сбор источника завершён.";
    if (operations.at(-1)?.message !== finalActivity) {
      operations.push({
        stage: `completed_${result.status}`,
        message: finalActivity,
        at: new Date().toISOString(),
        elapsedMs: Date.now() - sourceStartedAt,
        attempt: attemptNumber,
        reviewsFound: result.reviews.length,
      });
    }
    onProgress?.({
      source,
      label: adapter.label,
      status: "completed",
      outcome: result.status,
      activity: finalActivity,
      attempt: attemptNumber,
      reviewsFound: result.reviews.length,
      pagesCollected: result.reviews.reduce((maximum, review) => Math.max(maximum, review.page), 0),
      operations: [...operations],
    });
    return result;
  };

  for (const source of sources) {
    results.set(source, await runSource(source, 1));
  }

  const retrySources = sources.filter((source) => {
    const result = results.get(source);
    return result ? shouldRetryReviewSource(result) : false;
  });
  for (const source of retrySources) {
    results.set(source, await runSource(source, 2));
  }

  const orderedResults = sources.map((source) => results.get(source)).filter((result): result is ReviewSourceResult => Boolean(result));
  return {
    query,
    sources: orderedResults,
    totalReviews: orderedResults.reduce((total, result) => total + result.reviews.length, 0),
    createdAt: new Date().toISOString(),
  };
}
