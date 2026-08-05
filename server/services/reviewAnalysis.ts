import { createHash } from "node:crypto";
import type { BrowserContext, Page, Response as PlaywrightResponse } from "playwright";
import type { ReviewAttemptLog, ReviewBrowserInfo, ReviewSearchResponse, ReviewSource, ReviewSourceResult, UserReview } from "../../src/shared/types.js";
import { getMetaBrowser } from "./metaSnapshot.js";

interface ReviewAdapter {
  source: ReviewSource;
  label: string;
  buildCandidates(query: string): string[];
  extract(page: Page, pageNumber: number): Promise<{ companyName?: string; reviews: UserReview[] }>;
}

const MAX_PAGES = 2;
const NAVIGATION_TIMEOUT_MS = 35_000;
const CHALLENGE_WAIT_MS = 15_000;

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

export function buildG2Candidates(query: string): string[] {
  const { domain, slug } = normalizeCompanyQuery(query);
  return unique([
    slug,
    domain.replaceAll(".", "-"),
    slug ? `${slug}-com` : "",
    slug ? `www-${slug}-com` : "",
  ]).map((candidate) => `https://www.g2.com/products/${candidate}/reviews`);
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

async function pageState(page: Page): Promise<{ blocked: boolean; notFound: boolean; title: string; preview: string }> {
  let state: { title: string; text: string; iframeCount: number; elementCount: number } | undefined;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      state = await page.evaluate(() => ({
        title: document.title,
        text: document.body?.innerText.slice(0, 30_000) ?? "",
        iframeCount: document.querySelectorAll("iframe").length,
        elementCount: document.body?.querySelectorAll("*").length ?? 0,
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
    "captcha",
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
    "404 error",
  ].some((phrase) => text.includes(phrase));
  return { blocked, notFound, title: state.title, preview: state.text.replace(/\s+/g, " ").trim().slice(0, 500) };
}

async function waitForChallenge(page: Page): Promise<Awaited<ReturnType<typeof pageState>>> {
  let state = await pageState(page);
  const deadline = Date.now() + CHALLENGE_WAIT_MS;
  while (state.blocked && Date.now() < deadline) {
    await page.waitForTimeout(1_500);
    state = await pageState(page);
  }
  return state;
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
  g2: {
    source: "g2",
    label: "G2",
    buildCandidates: buildG2Candidates,
    extract: (page, pageNumber) => extractReviews(page, "g2", pageNumber),
  },
};

async function createContext(): Promise<{ context: BrowserContext; browser: ReviewBrowserInfo }> {
  const browser = await getMetaBrowser();
  const rawVersion = browser.version();
  const version = rawVersion.match(/\d+(?:\.\d+){1,3}/)?.[0] ?? rawVersion;
  const majorVersion = version.match(/^\d+/)?.[0] ?? "126";
  const userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  const context = await browser.newContext({
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
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });
  return { context, browser: { version, userAgent } };
}

async function scrapeSource(adapter: ReviewAdapter, query: string): Promise<ReviewSourceResult> {
  const candidates = adapter.buildCandidates(query);
  const attemptedUrls: string[] = [];
  const attempts: ReviewAttemptLog[] = [];
  const created = await createContext();
  const { context, browser } = created;
  const record = (attempt: ReviewAttemptLog) => {
    attempts.push(attempt);
    console.info(`[review-analysis:${adapter.source}]`, JSON.stringify(attempt));
  };
  try {
    let lastError = "";
    for (const candidate of candidates) {
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      attemptedUrls.push(candidate);
      const startedAt = Date.now();
      try {
        const navigation = await navigateStable(page, candidate);
        const response = navigation.response;
        await page.waitForTimeout(700);
        const state = await waitForChallenge(page);
        const blockedByStatus = response ? [401, 403, 429].includes(response.status()) : false;
        const firstAttempt: ReviewAttemptLog = {
          url: candidate,
          finalUrl: page.url(),
          httpStatus: response?.status(),
          title: state.title,
          outcome: state.blocked || blockedByStatus ? "blocked" : response?.status() === 404 || state.notFound ? "not_found" : "loaded",
          durationMs: Date.now() - startedAt,
          pagePreview: state.preview,
          ...(navigation.warning ? { message: `Chromium обработал автоматический редирект: ${navigation.warning}` } : {}),
        };
        if (state.blocked || blockedByStatus) {
          firstAttempt.message = blockedByStatus
            ? `Источник вернул HTTP ${response?.status()} для IP сервера.`
            : `JS-проверка не завершилась за ${Math.round(CHALLENGE_WAIT_MS / 1_000)} секунд.`;
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
        if (response?.status() === 404 || state.notFound) {
          record(firstAttempt);
          continue;
        }

        const allReviews: UserReview[] = [];
        let companyName: string | undefined;
        let profileUrl = page.url();
        for (let currentPage = 1; currentPage <= MAX_PAGES; currentPage += 1) {
          const target = pageUrl(candidate, currentPage);
          let currentAttempt = firstAttempt;
          if (currentPage > 1) {
            attemptedUrls.push(target);
            const pageStartedAt = Date.now();
            const nextNavigation = await navigateStable(page, target);
            const nextResponse = nextNavigation.response;
            await page.waitForTimeout(700);
            const nextState = await waitForChallenge(page);
            const nextBlockedByStatus = nextResponse ? [401, 403, 429].includes(nextResponse.status()) : false;
            currentAttempt = {
              url: target,
              finalUrl: page.url(),
              httpStatus: nextResponse?.status(),
              title: nextState.title,
              outcome: nextState.blocked || nextBlockedByStatus ? "blocked" : nextResponse?.status() === 404 || nextState.notFound ? "not_found" : "loaded",
              durationMs: Date.now() - pageStartedAt,
              pagePreview: nextState.preview,
              ...(nextNavigation.warning ? { message: `Chromium обработал автоматический редирект: ${nextNavigation.warning}` } : {}),
            };
            if (nextState.blocked || nextBlockedByStatus || nextResponse?.status() === 404 || nextState.notFound) {
              currentAttempt.message = nextBlockedByStatus
                ? `Источник вернул HTTP ${nextResponse?.status()} для IP сервера.`
                : nextState.blocked ? `JS-проверка не завершилась за ${Math.round(CHALLENGE_WAIT_MS / 1_000)} секунд.` : "Вторая страница не найдена.";
              record(currentAttempt);
              break;
            }
          }
          const extractionStartedAt = Date.now();
          const extracted = await adapter.extract(page, currentPage);
          companyName ||= extracted.companyName;
          allReviews.push(...extracted.reviews);
          currentAttempt.reviewsFound = extracted.reviews.length;
          currentAttempt.outcome = extracted.reviews.length ? "found" : "empty";
          currentAttempt.durationMs += Date.now() - extractionStartedAt;
          if (!extracted.reviews.length) currentAttempt.message = "Страница открылась, но подходящие карточки отзывов в DOM не найдены.";
          record(currentAttempt);
          if (!extracted.reviews.length) break;
        }
        const reviews = deduplicateReviews(allReviews);
        if (!reviews.length) {
          lastError = `Страница ${adapter.label} открылась, но отзывы не найдены в текущей разметке.`;
          continue;
        }
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
    await context.close();
  }
}

export async function searchCompanyReviews(query: string, sources: ReviewSource[]): Promise<ReviewSearchResponse> {
  const results = await Promise.all(sources.map(async (source) => {
    try {
      return await scrapeSource(adapters[source], query);
    } catch (error) {
      return {
        source,
        label: adapters[source].label,
        status: "error" as const,
        query,
        attemptedUrls: adapters[source].buildCandidates(query),
        attempts: [],
        reviews: [],
        message: error instanceof Error ? error.message : "Неизвестная ошибка браузерного сбора.",
      };
    }
  }));
  return {
    query,
    sources: results,
    totalReviews: results.reduce((total, result) => total + result.reviews.length, 0),
    createdAt: new Date().toISOString(),
  };
}
