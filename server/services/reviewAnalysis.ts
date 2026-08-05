import { createHash } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import type { ReviewSearchResponse, ReviewSource, ReviewSourceResult, UserReview } from "../../src/shared/types.js";
import { getMetaBrowser } from "./metaSnapshot.js";

interface ReviewAdapter {
  source: ReviewSource;
  label: string;
  buildCandidates(query: string): string[];
  extract(page: Page, pageNumber: number): Promise<{ companyName?: string; reviews: UserReview[] }>;
}

const MAX_PAGES = 2;
const NAVIGATION_TIMEOUT_MS = 35_000;

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

async function pageState(page: Page): Promise<{ blocked: boolean; notFound: boolean; text: string }> {
  const state = await page.evaluate(() => ({
    title: document.title,
    text: document.body?.innerText.slice(0, 30_000) ?? "",
    iframeCount: document.querySelectorAll("iframe").length,
    elementCount: document.body?.querySelectorAll("*").length ?? 0,
  }));
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
  return { blocked, notFound, text };
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

async function createContext(): Promise<BrowserContext> {
  const browser = await getMetaBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1_000 },
    locale: "en-US",
    timezoneId: "UTC",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return context;
}

async function scrapeSource(adapter: ReviewAdapter, query: string): Promise<ReviewSourceResult> {
  const candidates = adapter.buildCandidates(query);
  const attemptedUrls: string[] = [];
  const context = await createContext();
  try {
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    let lastError = "";
    for (const candidate of candidates) {
      attemptedUrls.push(candidate);
      try {
        const response = await page.goto(candidate, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1_200);
        const state = await pageState(page);
        if (state.blocked) {
          return {
            source: adapter.source,
            label: adapter.label,
            status: "blocked",
            query,
            profileUrl: candidate,
            attemptedUrls,
            reviews: [],
            message: `${adapter.label} включил проверку браузера и не отдал страницу отзывов серверу. Повторите запрос позже.`,
          };
        }
        if (response?.status() === 404 || state.notFound) continue;

        const allReviews: UserReview[] = [];
        let companyName: string | undefined;
        for (let currentPage = 1; currentPage <= MAX_PAGES; currentPage += 1) {
          const target = pageUrl(candidate, currentPage);
          if (currentPage > 1) {
            attemptedUrls.push(target);
            await page.goto(target, { waitUntil: "domcontentloaded" });
            await page.waitForTimeout(1_000);
            const nextState = await pageState(page);
            if (nextState.blocked || nextState.notFound) break;
          }
          const extracted = await adapter.extract(page, currentPage);
          companyName ||= extracted.companyName;
          allReviews.push(...extracted.reviews);
          if (!extracted.reviews.length && currentPage === 1) break;
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
          profileUrl: candidate,
          attemptedUrls,
          reviews,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      source: adapter.source,
      label: adapter.label,
      status: lastError ? "error" : "not_found",
      query,
      attemptedUrls,
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
