import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { Page, Route } from "playwright";
import type { AdCreative, AIAnalysisResponse, CreativeCollection, NicheAnalysis } from "../../src/shared/types.js";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { getMetaBrowser, getMetaMedia, registerMetaAd } from "./metaSnapshot.js";

const OPENAI_MODEL = "gpt-5.6";
const MAX_CREATIVES = 8;
const SCREENSHOT_TIMEOUT_MS = 30_000;

interface StoredCreative {
  ad: AdCreative;
  sourcePayload?: unknown;
}

interface PreparedCreative {
  ad: AdCreative;
  creativeImage?: string;
  landingImage?: string;
  landingUrl?: string;
  warning?: string;
}

interface OpenAIResponse {
  id?: string;
  status?: "completed" | "incomplete" | "failed" | "cancelled" | "queued" | "in_progress";
  incomplete_details?: { reason?: string };
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
  }>;
  error?: { message?: string; code?: string };
}

function snapshotUrlFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>).ad_snapshot_url;
  return typeof value === "string" ? value : undefined;
}

function dataUrl(buffer: Buffer): string {
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff") || normalized.startsWith("2001:db8")) return true;
  if (isIP(normalized) !== 4) return false;
  const [a, b, c] = normalized.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError(400, "INVALID_LANDING_URL", "Некорректная ссылка лендинга.");
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new AppError(400, "INVALID_LANDING_URL", "Разрешены только публичные HTTP/HTTPS-лендинги.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isPrivateIp(hostname)) {
    throw new AppError(400, "PRIVATE_LANDING_URL", "Внутренние адреса нельзя открывать для AI-аналитики.");
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new AppError(400, "PRIVATE_LANDING_URL", "Лендинг не имеет безопасного публичного адреса.");
  }
  return url;
}

async function installSafeRouting(page: Page, allowLocalMedia = false): Promise<void> {
  const decisions = new Map<string, Promise<boolean>>();
  await page.route("**/*", async (route: Route) => {
    const rawUrl = route.request().url();
    if (rawUrl.startsWith("data:") || rawUrl.startsWith("blob:") || rawUrl === "about:blank") {
      await route.continue();
      return;
    }
    if (allowLocalMedia && rawUrl.startsWith(`http://127.0.0.1:${config.port}/api/meta/media/`)) {
      await route.continue();
      return;
    }
    let hostname: string;
    try { hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { await route.abort("blockedbyclient"); return; }
    const decision = decisions.get(hostname) ?? assertPublicHttpUrl(rawUrl).then(() => true).catch(() => false);
    decisions.set(hostname, decision);
    if (await decision) await route.continue();
    else await route.abort("blockedbyclient");
  });
}

async function renderCreative(mediaType: AdCreative["mediaType"], mediaUrl: string, thumbnailUrl?: string): Promise<string | undefined> {
  const browser = await getMetaBrowser();
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await context.newPage();
  try {
    await installSafeRouting(page, true);
    await page.setContent('<main id="frame"></main><style>html,body{margin:0;background:#111725}body{display:grid;place-items:center;min-height:100vh}#frame{display:grid;place-items:center;width:900px;height:900px;overflow:hidden;background:#111725}img,video{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain}</style>');
    const source = mediaType === "video" ? mediaUrl : (mediaUrl || thumbnailUrl || "");
    if (!source) return undefined;
    await page.evaluate(({ kind, src, poster }) => {
      const frame = document.querySelector("#frame") as HTMLElement;
      if (kind === "video") {
        const video = document.createElement("video");
        video.id = "creative";
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        if (poster) video.poster = poster;
        video.src = src;
        frame.append(video);
      } else {
        const image = document.createElement("img");
        image.id = "creative";
        image.src = src;
        frame.append(image);
      }
    }, { kind: mediaType === "video" ? "video" : "image", src: source, poster: thumbnailUrl });
    if (mediaType === "video") {
      try {
        await page.waitForFunction(() => (document.querySelector("#creative") as HTMLVideoElement | null)?.readyState && (document.querySelector("#creative") as HTMLVideoElement).readyState >= 2, undefined, { timeout: SCREENSHOT_TIMEOUT_MS });
        await page.evaluate(() => {
          const video = document.querySelector("#creative") as HTMLVideoElement;
          video.pause();
          if (video.duration > 0.15) video.currentTime = 0.1;
        });
        await page.waitForTimeout(250);
      } catch {
        if (!thumbnailUrl) return undefined;
        await page.evaluate((poster) => {
          const current = document.querySelector("#creative");
          const image = document.createElement("img");
          image.id = "creative";
          image.src = poster;
          current?.replaceWith(image);
        }, thumbnailUrl);
        await page.waitForFunction(() => (document.querySelector("#creative") as HTMLImageElement | null)?.complete, undefined, { timeout: 15_000 });
      }
    } else {
      await page.waitForFunction(() => {
        const image = document.querySelector("#creative") as HTMLImageElement | null;
        return Boolean(image?.complete && image.naturalWidth > 0);
      }, undefined, { timeout: SCREENSHOT_TIMEOUT_MS });
    }
    const element = page.locator("#creative");
    return dataUrl(await element.screenshot({ type: "jpeg", quality: 72 }));
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function scrollLanding(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const maxHeight = Math.min(document.documentElement.scrollHeight, 20_000);
    for (let y = 0; y < maxHeight; y += 700) {
      window.scrollTo(0, y);
      await delay(90);
    }
    window.scrollTo(0, 0);
  });
}

async function renderLanding(rawUrl: string): Promise<string> {
  await assertPublicHttpUrl(rawUrl);
  const browser = await getMetaBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "ru-RU" });
  const page = await context.newPage();
  try {
    await installSafeRouting(page);
    const response = await page.goto(rawUrl, { waitUntil: "domcontentloaded", timeout: SCREENSHOT_TIMEOUT_MS });
    if (!response || !response.ok()) throw new AppError(502, "LANDING_PAGE_FAILED", `Лендинг ответил HTTP ${response?.status() ?? "?"}.`);
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    await scrollLanding(page);
    const buffer = await page.screenshot({ type: "jpeg", quality: 48, fullPage: true });
    return dataUrl(buffer);
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function prepareCreative(item: StoredCreative): Promise<PreparedCreative> {
  let ad = { ...item.ad };
  const warnings: string[] = [];
  if (ad.source === "meta") {
    const externalId = ad.id.replace(/^meta-/, "");
    registerMetaAd(externalId, snapshotUrlFromPayload(item.sourcePayload));
    try {
      const resolved = await getMetaMedia(externalId);
      ad = {
        ...ad,
        mediaType: resolved.mediaType,
        mediaUrl: resolved.mediaUrl,
        thumbnailUrl: resolved.thumbnailUrl || ad.thumbnailUrl,
        advertiserAvatar: resolved.advertiserAvatar || ad.advertiserAvatar,
        landingUrl: resolved.landingUrl || ad.landingUrl,
        cta: resolved.cta || ad.cta,
      };
    } catch (error) {
      warnings.push(`Meta media: ${error instanceof Error ? error.message : "не удалось обновить"}`);
    }
  }

  const localBase = `http://127.0.0.1:${config.port}`;
  const absolute = (url?: string) => url?.startsWith("/") ? `${localBase}${url}` : url;
  let creativeImage: string | undefined;
  try {
    creativeImage = await renderCreative(ad.mediaType, absolute(ad.mediaUrl) ?? "", absolute(ad.thumbnailUrl));
  } catch (error) {
    warnings.push(`Креатив: ${error instanceof Error ? error.message : "скриншот недоступен"}`);
  }

  let landingImage: string | undefined;
  if (ad.landingUrl) {
    try {
      landingImage = await renderLanding(ad.landingUrl);
    } catch (error) {
      warnings.push(`Лендинг: ${error instanceof Error ? error.message : "скриншот недоступен"}`);
    }
  } else {
    warnings.push("У объявления не найден CTA-лендинг");
  }
  return { ad, creativeImage, landingImage, landingUrl: ad.landingUrl, warning: warnings.join("; ") || undefined };
}

export function buildAnalysisPrompt(collection: CreativeCollection, creatives: PreparedCreative[]): string {
  const rows = creatives.map(({ ad, landingUrl }, index) => ({
    index: index + 1,
    adId: ad.id,
    advertiser: ad.advertiser,
    shortHeadline: ad.headline || "не указан",
    longText: ad.body || "не указан",
    cta: ad.cta || "не указан",
    daysActive: ad.daysActive,
    activeNow: !ad.endedAt || new Date(ad.endedAt).getTime() >= Date.now(),
    startedAt: ad.startedAt,
    endedAt: ad.endedAt ?? null,
    reachOrViews: ad.reach ?? null,
    countries: ad.countries?.length ? ad.countries : [ad.countryName || ad.country],
    platforms: ad.platforms,
    landingUrl: landingUrl ?? null,
    imageOrder: `Сразу после текста объявления ${index + 1}: сначала креатив/первый кадр, затем полный скриншот лендинга (если доступен).`,
  }));
  return [
    `Проанализируй рекламную коллекцию «${collection.name}» как senior performance-маркетолог и product researcher.`,
    "Цель: оценить перспективность ниши и рекламной связки креатив → оффер → лендинг, найти повторяющиеся сигналы спроса и предложить проверяемый план тестов.",
    "Используй только переданные факты и изображения. Длительность и охват — косвенные сигналы, а не доказательство прибыли. Не выдумывай продажи, ROAS, бюджет, конверсии или демографию. Если данных мало или часть скриншотов недоступна, явно снизь confidence и укажи это в caveats.",
    "Сопоставляй каждую пару изображений с объявлением по порядку. Оценивай hook, визуальный паттерн, обещание, доказательства, CTA, согласованность лендинга с объявлением, ясность оффера, friction и возможные policy/market risks.",
    "Opportunity score 0–100 должен учитывать устойчивость активности, охват (когда он есть), повторяемость паттернов между независимыми рекламодателями, качество оффера/лендинга и риски. Рекомендации должны быть конкретными и пригодными для запуска рекламных тестов.",
    `Метаданные объявлений:\n${JSON.stringify(rows, null, 2)}`,
  ].join("\n\n");
}

const stringArray = { type: "array", items: { type: "string" } } as const;
const analysisSchema = {
  type: "object",
  additionalProperties: false,
  required: ["niche", "executiveSummary", "opportunityScore", "confidence", "demandSignals", "winningPatterns", "audienceInsights", "landingInsights", "risks", "recommendations", "testPlan", "creativeFindings", "caveats"],
  properties: {
    niche: { type: "string" },
    executiveSummary: { type: "string" },
    opportunityScore: { type: "integer", minimum: 0, maximum: 100 },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    demandSignals: stringArray,
    winningPatterns: stringArray,
    audienceInsights: stringArray,
    landingInsights: stringArray,
    risks: stringArray,
    recommendations: stringArray,
    testPlan: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["priority", "hypothesis", "creativeAngle", "offer"],
        properties: {
          priority: { type: "string", enum: ["high", "medium", "low"] },
          hypothesis: { type: "string" },
          creativeAngle: { type: "string" },
          offer: { type: "string" },
        },
      },
    },
    creativeFindings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["adId", "advertiser", "verdict", "evidence", "improvements"],
        properties: {
          adId: { type: "string" },
          advertiser: { type: "string" },
          verdict: { type: "string" },
          evidence: stringArray,
          improvements: stringArray,
        },
      },
    },
    caveats: stringArray,
  },
} as const;

function extractOutputText(payload: OpenAIResponse): string | undefined {
  return payload.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text;
}

function extractRefusal(payload: OpenAIResponse): string | undefined {
  return payload.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "refusal")?.refusal;
}

function responseDiagnostics(payload: OpenAIResponse, outputText?: string): Record<string, unknown> {
  return {
    responseId: payload.id,
    status: payload.status,
    incompleteReason: payload.incomplete_details?.reason,
    outputTypes: payload.output?.map((item) => item.type),
    contentTypes: payload.output?.flatMap((item) => item.content ?? []).map((item) => item.type),
    outputTextLength: outputText?.length ?? 0,
    outputLooksComplete: Boolean(outputText?.trim().endsWith("}")),
  };
}

export function parseAnalysisOutput(outputText: string): NicheAnalysis {
  const normalized = outputText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  return JSON.parse(normalized) as NicheAnalysis;
}

async function requestOpenAI(apiKey: string, clientId: string, collection: CreativeCollection, creatives: PreparedCreative[]): Promise<NicheAnalysis> {
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: buildAnalysisPrompt(collection, creatives) }];
  creatives.forEach((creative, index) => {
    content.push({ type: "input_text", text: `Объявление ${index + 1}: креатив${creative.creativeImage ? "" : " недоступен"}.` });
    if (creative.creativeImage) content.push({ type: "input_image", image_url: creative.creativeImage, detail: "high" });
    content.push({ type: "input_text", text: `Объявление ${index + 1}: полный скриншот CTA-лендинга${creative.landingImage ? "" : " недоступен"}.` });
    if (creative.landingImage) content.push({ type: "input_image", image_url: creative.landingImage, detail: "high" });
  });

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model: OPENAI_MODEL,
      store: false,
      safety_identifier: createHash("sha256").update(clientId).digest("hex"),
      reasoning: { effort: "medium" },
      max_output_tokens: 16_000,
      input: [{ role: "user", content }],
      text: {
        verbosity: "medium",
        format: { type: "json_schema", name: "niche_analysis", strict: true, schema: analysisSchema },
      },
    }),
  });
  const payload = await response.json().catch(() => ({})) as OpenAIResponse;
  if (!response.ok) {
    const message = payload.error?.message ?? `OpenAI API ответил HTTP ${response.status}`;
    if (response.status === 401) throw new AppError(401, "OPENAI_KEY_INVALID", "OpenAI API-ключ недействителен или отозван.", "Откройте Настройки и сохраните актуальный ключ.");
    if (response.status === 429) throw new AppError(429, "OPENAI_LIMIT", "OpenAI отклонил запрос из-за лимита или отсутствия средств.", "Проверьте Billing и лимиты проекта OpenAI.");
    throw new AppError(502, "OPENAI_API_ERROR", message);
  }
  const outputText = extractOutputText(payload);
  if (payload.status === "incomplete") {
    console.warn("OpenAI analysis response was incomplete", responseDiagnostics(payload, outputText));
    throw new AppError(
      502,
      "OPENAI_INCOMPLETE_RESPONSE",
      "OpenAI не успел сформировать полный отчёт.",
      "Повторите анализ. Если ошибка повторится, уменьшите количество креативов в коллекции.",
    );
  }
  const refusal = extractRefusal(payload);
  if (refusal) {
    console.warn("OpenAI refused collection analysis", responseDiagnostics(payload, outputText));
    throw new AppError(422, "OPENAI_REFUSAL", "OpenAI отказался анализировать содержимое одного из креативов.");
  }
  if (!outputText) {
    console.warn("OpenAI analysis response contained no output text", responseDiagnostics(payload));
    throw new AppError(502, "OPENAI_EMPTY_RESPONSE", "OpenAI не вернул текст аналитики.");
  }
  try {
    return parseAnalysisOutput(outputText);
  } catch (error) {
    console.warn("OpenAI analysis response was not valid JSON", {
      ...responseDiagnostics(payload, outputText),
      parseError: error instanceof Error ? error.message : "unknown",
    });
    throw new AppError(
      502,
      "OPENAI_INVALID_RESPONSE",
      "OpenAI вернул аналитику в неожиданном формате.",
      "Повторите анализ. В журнале сервера сохранена безопасная диагностика ответа.",
    );
  }
}

export async function analyzeCollection(options: {
  apiKey: string;
  clientId: string;
  collection: CreativeCollection;
  items: StoredCreative[];
}): Promise<AIAnalysisResponse> {
  const selected = options.items.slice(0, MAX_CREATIVES);
  const prepared: PreparedCreative[] = [];
  for (const item of selected) prepared.push(await prepareCreative(item));
  const warnings = prepared.flatMap((item) => item.warning ? [`${item.ad.advertiser}: ${item.warning}`] : []);
  if (options.items.length > MAX_CREATIVES) warnings.push(`Для контроля стоимости проанализированы первые ${MAX_CREATIVES} из ${options.items.length} креативов.`);
  const analysis = await requestOpenAI(options.apiKey, options.clientId, options.collection, prepared);
  return {
    collection: options.collection,
    analysis,
    model: OPENAI_MODEL,
    analyzedCount: prepared.length,
    totalCount: options.items.length,
    warnings,
  };
}
