import type { BrowserContext } from "playwright";
import type {
  GoogleTrendsKeywordRelated,
  GoogleTrendsLogEntry,
  GoogleTrendsProgress,
  GoogleTrendsRegionRow,
  GoogleTrendsRelatedItem,
  GoogleTrendsReport,
  GoogleTrendsRequest,
  GoogleTrendsSeriesSummary,
  GoogleTrendsTimelinePoint,
} from "../../src/shared/types.js";
import { AppError } from "../errors.js";
import { getMetaBrowser } from "./metaSnapshot.js";

const TRENDS_ORIGIN = "https://trends.google.com";
const MAX_NATIVE_COMPARISON = 8;
const MAX_RETRIES = 3;

interface TrendsWidget {
  id?: string;
  type?: string;
  token?: string;
  request?: unknown;
}

interface NativeTimelinePoint {
  timestamp: number;
  label: string;
  values: number[];
  partial?: boolean;
}

interface NativeRegionRow {
  code: string;
  name: string;
  values: number[];
}

interface NativeBatch {
  keywords: string[];
  timeline: NativeTimelinePoint[];
  averages: number[];
  related: Map<string, GoogleTrendsKeywordRelated>;
  regions: NativeRegionRow[];
}

type ProgressReporter = (progress: GoogleTrendsProgress) => void;
type LogDetails = Record<string, string | number | boolean>;

const timeRangeLabels: Record<GoogleTrendsRequest["timeRange"], string> = {
  "now 7-d": "Последние 7 дней",
  "today 1-m": "Последние 30 дней",
  "today 3-m": "Последние 90 дней",
  "today 12-m": "Последние 12 месяцев",
  "today 5-y": "Последние 5 лет",
  all: "С 2004 года",
};

const propertyLabels: Record<GoogleTrendsRequest["property"], string> = {
  "": "Веб-поиск",
  images: "Поиск по картинкам",
  news: "Поиск по новостям",
  youtube: "YouTube",
  froogle: "Google Покупки",
};

function countryName(country: string): string {
  if (country === "ALL") return "Весь мир";
  try {
    return new Intl.DisplayNames(["ru"], { type: "region" }).of(country) ?? country;
  } catch {
    return country;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function parseGoogleTrendsJson(raw: string): unknown {
  const objectOffset = raw.indexOf("{");
  const arrayOffset = raw.indexOf("[");
  const offsets = [objectOffset, arrayOffset].filter((offset) => offset >= 0);
  if (!offsets.length) throw new Error("Google Trends вернул пустой ответ.");
  return JSON.parse(raw.slice(Math.min(...offsets)));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function widgetKeyword(widget: TrendsWidget): string | undefined {
  const request = asRecord(widget.request);
  const restriction = asRecord(request?.restriction);
  const complex = asRecord(restriction?.complexKeywordsRestriction ?? request?.complexKeywordsRestriction);
  const keyword = asRecord(asArray(complex?.keyword)[0]);
  return typeof keyword?.value === "string" ? keyword.value : undefined;
}

function rankedItems(value: unknown): GoogleTrendsRelatedItem[] {
  const list = asRecord(value);
  return asArray(list?.rankedKeyword).flatMap((rawItem) => {
    const item = asRecord(rawItem);
    const topic = asRecord(item?.topic);
    const query = typeof item?.query === "string" ? item.query : typeof topic?.title === "string" ? topic.title : "";
    if (!query) return [];
    const numeric = Number(item?.value);
    return [{
      query,
      ...(Number.isFinite(numeric) ? { value: numeric } : {}),
      ...(typeof item?.formattedValue === "string" ? { formattedValue: item.formattedValue } : {}),
      ...(typeof item?.link === "string" ? { link: new URL(item.link, TRENDS_ORIGIN).toString() } : {}),
    }];
  });
}

export function parseRelatedSearches(payload: unknown, keyword: string): GoogleTrendsKeywordRelated {
  const root = asRecord(payload);
  const defaults = asRecord(root?.default);
  const lists = asArray(defaults?.rankedList);
  return { keyword, top: rankedItems(lists[0]), rising: rankedItems(lists[1]) };
}

function parseTimeline(payload: unknown): { points: NativeTimelinePoint[]; averages: number[] } {
  const root = asRecord(payload);
  const defaults = asRecord(root?.default);
  const points = asArray(defaults?.timelineData).flatMap((rawPoint) => {
    const point = asRecord(rawPoint);
    const timestamp = Number(point?.time);
    const values = asArray(point?.value).map(numberValue);
    if (!Number.isFinite(timestamp) || !values.length) return [];
    return [{
      timestamp,
      label: typeof point?.formattedTime === "string" ? point.formattedTime : new Date(timestamp * 1_000).toLocaleDateString("ru-RU"),
      values,
      ...(point?.isPartial === true ? { partial: true } : {}),
    }];
  });
  const averages = asArray(defaults?.averages).map(numberValue);
  return { points, averages };
}

function parseRegions(payload: unknown): NativeRegionRow[] {
  const root = asRecord(payload);
  const defaults = asRecord(root?.default);
  return asArray(defaults?.geoMapData).flatMap((rawRow) => {
    const row = asRecord(rawRow);
    const code = typeof row?.geoCode === "string" ? row.geoCode : "";
    const name = typeof row?.geoName === "string" ? row.geoName : code;
    const values = asArray(row?.value).map(numberValue);
    return code && values.length ? [{ code, name, values }] : [];
  });
}

function buildSourceUrl(request: GoogleTrendsRequest): string {
  const params = new URLSearchParams({
    ...(request.country !== "ALL" ? { geo: request.country } : {}),
    date: request.timeRange,
    q: request.keywords.join(","),
    ...(request.property ? { gprop: request.property } : {}),
    hl: "ru",
  });
  return `${TRENDS_ORIGIN}/trends/explore?${params}`;
}

function requestUrl(path: string, request: unknown, token?: string): string {
  const params = new URLSearchParams({ hl: "ru", tz: "-180", req: JSON.stringify(request) });
  if (token) params.set("token", token);
  return `${TRENDS_ORIGIN}/trends/api/${path}?${params}`;
}

async function googleJson(
  context: BrowserContext,
  url: string,
  stage: string,
  log: (stage: string, status: GoogleTrendsLogEntry["status"], message: string, details?: LogDetails) => void,
): Promise<unknown> {
  let lastStatus = 0;
  let lastPreview = "";
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await context.request.get(url, {
      headers: {
        accept: "application/json,text/plain,*/*",
        referer: `${TRENDS_ORIGIN}/trends/explore?hl=ru`,
        "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
      },
      timeout: 45_000,
    });
    lastStatus = response.status();
    const raw = await response.text();
    lastPreview = raw.replace(/\s+/g, " ").slice(0, 1_200);
    if (response.ok()) {
      try {
        return parseGoogleTrendsJson(raw);
      } catch (error) {
        throw new AppError(502, "GOOGLE_TRENDS_INVALID_RESPONSE", "Google Trends вернул данные в неожиданном формате.", "Повторите сбор позже.", {
          stage,
          responsePreview: lastPreview,
          parseError: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
    log(stage, attempt < MAX_RETRIES && (lastStatus === 429 || lastStatus >= 500) ? "info" : "error", `Google Trends вернул HTTP ${lastStatus}.`, { attempt, httpStatus: lastStatus });
    if (attempt < MAX_RETRIES && (lastStatus === 429 || lastStatus >= 500)) await delay(attempt * 1_500);
    else break;
  }
  throw new AppError(
    lastStatus === 429 ? 429 : 502,
    lastStatus === 429 ? "GOOGLE_TRENDS_RATE_LIMIT" : "GOOGLE_TRENDS_SOURCE_ERROR",
    lastStatus === 429 ? "Google Trends временно ограничил частоту запросов." : `Google Trends вернул HTTP ${lastStatus || "без ответа"}.`,
    "Подождите несколько минут и повторите сбор.",
    { stage, httpStatus: lastStatus, responsePreview: lastPreview },
  );
}

async function widgetJson(
  context: BrowserContext,
  widget: TrendsWidget,
  endpoint: "multiline" | "relatedsearches" | "comparedgeo",
  stage: string,
  log: (stage: string, status: GoogleTrendsLogEntry["status"], message: string, details?: LogDetails) => void,
): Promise<unknown> {
  if (!widget.request || !widget.token) throw new Error(`Google Trends не вернул token/request для ${stage}.`);
  return googleJson(context, requestUrl(`widgetdata/${endpoint}`, widget.request, widget.token), stage, log);
}

async function collectNativeBatch(
  context: BrowserContext,
  request: GoogleTrendsRequest,
  keywords: string[],
  batchNumber: number,
  batchCount: number,
  log: (stage: string, status: GoogleTrendsLogEntry["status"], message: string, details?: LogDetails) => void,
): Promise<NativeBatch> {
  const geo = request.country === "ALL" ? "" : request.country;
  const exploreRequest = {
    comparisonItem: keywords.map((keyword) => ({ keyword, geo, time: request.timeRange })),
    category: 0,
    property: request.property,
  };
  const batchStage = `explore_${batchNumber}`;
  log(batchStage, "started", `Получаем набор сравнения ${batchNumber} из ${batchCount}.`, { keywordCount: keywords.length });
  const explore = asRecord(await googleJson(context, requestUrl("explore", exploreRequest), batchStage, log));
  const widgets = asArray(explore?.widgets).map((widget) => asRecord(widget) as TrendsWidget).filter(Boolean);
  const timelineWidget = widgets.find((widget) => widget.id === "TIMESERIES" || widget.type === "fe_line_chart");
  if (!timelineWidget) throw new AppError(502, "GOOGLE_TRENDS_TIMELINE_MISSING", "Google Trends не вернул график динамики популярности.");

  const timelinePayload = await widgetJson(context, timelineWidget, "multiline", `timeline_${batchNumber}`, log);
  const timeline = parseTimeline(timelinePayload);
  log(`timeline_${batchNumber}`, "success", `Получено ${timeline.points.length} точек графика.`, { pointCount: timeline.points.length });

  const related = new Map<string, GoogleTrendsKeywordRelated>();
  const queryWidgets = widgets.filter((widget) => widget.id?.startsWith("RELATED_QUERIES"));
  const relatedWidgets = (queryWidgets.length ? queryWidgets : widgets.filter((widget) => widget.type === "fe_related_searches"))
    .sort((left, right) => String(left.id).localeCompare(String(right.id), undefined, { numeric: true }));
  for (let index = 0; index < keywords.length; index += 1) {
    const keyword = keywords[index];
    const widget = relatedWidgets.find((candidate) => widgetKeyword(candidate)?.toLocaleLowerCase() === keyword.toLocaleLowerCase()) ?? relatedWidgets[index];
    if (!widget) {
      related.set(keyword, { keyword, top: [], rising: [] });
      log(`related_${batchNumber}_${index + 1}`, "info", `Для «${keyword}» Google не вернул блок связанных запросов.`);
      continue;
    }
    const stage = `related_${batchNumber}_${index + 1}`;
    log(stage, "started", `Собираем популярные и растущие запросы для «${keyword}».`, { keyword, keywordIndex: index + 1 });
    const parsed = parseRelatedSearches(await widgetJson(context, widget, "relatedsearches", stage, log), keyword);
    related.set(keyword, parsed);
    log(stage, "success", `Для «${keyword}» получено ${parsed.top.length} популярных и ${parsed.rising.length} растущих запросов.`, {
      keyword,
      topCount: parsed.top.length,
      risingCount: parsed.rising.length,
    });
  }

  let regions: NativeRegionRow[] = [];
  const regionWidget = widgets.find((widget) => widget.id === "GEO_MAP" || widget.type === "fe_geo_chart");
  if (regionWidget) {
    try {
      regions = parseRegions(await widgetJson(context, regionWidget, "comparedgeo", `regions_${batchNumber}`, log));
      log(`regions_${batchNumber}`, "success", `Получено ${regions.length} строк географии интереса.`, { regionCount: regions.length });
    } catch (error) {
      log(`regions_${batchNumber}`, "info", "Географическая детализация недоступна, основной отчёт продолжен.", { error: error instanceof Error ? error.message : "Unknown error" });
    }
  }
  log(batchStage, "success", `Набор сравнения ${batchNumber} обработан.`, { keywordCount: keywords.length });
  return { keywords, timeline: timeline.points, averages: timeline.averages, related, regions };
}

function average(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function roundIndex(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function buildBatches(keywords: string[]): string[][] {
  if (keywords.length <= MAX_NATIVE_COMPARISON) return [keywords];
  const anchor = keywords[0];
  return [keywords.slice(0, MAX_NATIVE_COMPARISON), [anchor, ...keywords.slice(MAX_NATIVE_COMPARISON)]];
}

export function mergeGoogleTrendsBatches(keywords: string[], batches: NativeBatch[]): {
  timeline: GoogleTrendsTimelinePoint[];
  series: GoogleTrendsSeriesSummary[];
  related: GoogleTrendsKeywordRelated[];
  regions: GoogleTrendsRegionRow[];
  normalized: boolean;
} {
  const reference = batches[0];
  if (!reference) return { timeline: [], series: [], related: [], regions: [], normalized: false };
  const anchor = keywords[0];
  const referenceAnchorIndex = reference.keywords.indexOf(anchor);
  const referenceAnchorAverage = reference.averages[referenceAnchorIndex] ?? average(reference.timeline.map((point) => point.values[referenceAnchorIndex] ?? 0));
  const factors = batches.map((batch, batchIndex) => {
    if (batchIndex === 0) return 1;
    const anchorIndex = batch.keywords.indexOf(anchor);
    const batchAverage = batch.averages[anchorIndex] ?? average(batch.timeline.map((point) => point.values[anchorIndex] ?? 0));
    return referenceAnchorAverage > 0 && batchAverage > 0 ? referenceAnchorAverage / batchAverage : 1;
  });
  const rawPoints = new Map<number, { label: string; partial?: boolean; values: number[] }>();
  batches.forEach((batch, batchIndex) => {
    batch.timeline.forEach((point) => {
      const row = rawPoints.get(point.timestamp) ?? { label: point.label, ...(point.partial ? { partial: true } : {}), values: Array(keywords.length).fill(0) };
      batch.keywords.forEach((keyword, localIndex) => {
        const globalIndex = keywords.indexOf(keyword);
        if (globalIndex < 0 || (batchIndex > 0 && keyword === anchor)) return;
        row.values[globalIndex] = (point.values[localIndex] ?? 0) * factors[batchIndex];
      });
      rawPoints.set(point.timestamp, row);
    });
  });
  const rawMaximum = Math.max(0, ...[...rawPoints.values()].flatMap((point) => point.values));
  const globalFactor = rawMaximum > 100 ? 100 / rawMaximum : 1;
  const timeline = [...rawPoints.entries()].sort(([left], [right]) => left - right).map(([timestamp, point]) => ({
    timestamp,
    label: point.label,
    values: point.values.map((value) => roundIndex(value * globalFactor)),
    ...(point.partial ? { partial: true } : {}),
  }));
  const series = keywords.map((keyword, keywordIndex): GoogleTrendsSeriesSummary => {
    const values = timeline.map((point) => point.values[keywordIndex] ?? 0);
    const maximum = Math.max(0, ...values);
    const peakIndex = values.indexOf(maximum);
    const windowSize = Math.max(1, Math.min(12, Math.floor(values.length / 4)));
    const currentWindow = values.slice(-windowSize);
    const previousWindow = values.slice(-windowSize * 2, -windowSize);
    const currentAverage = average(currentWindow);
    const previousAverage = average(previousWindow);
    return {
      keyword,
      average: roundIndex(average(values)),
      current: roundIndex(values.at(-1) ?? 0),
      minimum: roundIndex(values.length ? Math.min(...values) : 0),
      maximum: roundIndex(maximum),
      ...(peakIndex >= 0 ? { peakLabel: timeline[peakIndex]?.label } : {}),
      ...(previousAverage > 0 ? { changePercent: Math.round(((currentAverage - previousAverage) / previousAverage) * 1_000) / 10 } : {}),
    };
  });
  const related = keywords.map((keyword) => batches.map((batch) => batch.related.get(keyword)).find(Boolean) ?? { keyword, top: [], rising: [] });
  const regionMap = new Map<string, GoogleTrendsRegionRow>();
  batches.forEach((batch, batchIndex) => {
    batch.regions.forEach((region) => {
      const row = regionMap.get(region.code) ?? { code: region.code, name: region.name, values: Array(keywords.length).fill(0) };
      batch.keywords.forEach((keyword, localIndex) => {
        const globalIndex = keywords.indexOf(keyword);
        if (globalIndex < 0 || (batchIndex > 0 && keyword === anchor)) return;
        row.values[globalIndex] = roundIndex((region.values[localIndex] ?? 0) * factors[batchIndex] * globalFactor);
      });
      regionMap.set(region.code, row);
    });
  });
  const regions = [...regionMap.values()].sort((left, right) => Math.max(...right.values) - Math.max(...left.values));
  return { timeline, series, related, regions, normalized: batches.length > 1 };
}

export async function collectGoogleTrends(request: GoogleTrendsRequest, onProgress?: ProgressReporter): Promise<GoogleTrendsReport> {
  const startedAt = Date.now();
  const logs: GoogleTrendsLogEntry[] = [];
  let completedSteps = 0;
  const batches = buildBatches(request.keywords);
  const totalSteps = 2 + batches.length + batches.reduce((total, batch) => total + batch.length, 0);
  const publish = (stage: string, activity: string) => onProgress?.({ stage, activity, completedSteps, totalSteps, logs: [...logs] });
  const log = (stage: string, status: GoogleTrendsLogEntry["status"], message: string, details?: LogDetails) => {
    logs.push({ at: new Date().toISOString(), stage, status, message, elapsedMs: Date.now() - startedAt, ...(details ? { details } : {}) });
    publish(stage, message);
  };
  let context: BrowserContext | undefined;
  try {
    log("browser", "started", "Запускаем изолированный Chromium для Google Trends.");
    const browser = await getMetaBrowser();
    context = await browser.newContext({ locale: "ru-RU", timezoneId: "Europe/Kyiv" });
    const page = await context.newPage();
    await page.goto(`${TRENDS_ORIGIN}/trends/explore?hl=ru`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    completedSteps += 1;
    log("browser", "success", "Google Trends открыт, cookie-сессия подготовлена.");

    const nativeBatches: NativeBatch[] = [];
    for (let index = 0; index < batches.length; index += 1) {
      const beforeRelatedLogs = logs.length;
      nativeBatches.push(await collectNativeBatch(context, request, batches[index], index + 1, batches.length, log));
      const relatedCompleted = logs.slice(beforeRelatedLogs).filter((entry) => entry.stage.startsWith("related_") && entry.status === "success").length;
      completedSteps += 1 + relatedCompleted;
      publish(`batch_${index + 1}`, `Сравнение ${index + 1} из ${batches.length} собрано.`);
    }
    const merged = mergeGoogleTrendsBatches(request.keywords, nativeBatches);
    completedSteps = totalSteps;
    const warnings = [
      "Google Trends показывает относительный индекс интереса от 0 до 100, а не абсолютное число поисков.",
      ...(merged.normalized ? ["Для 6–8 ключей использовано сравнение групп через общий опорный ключ; значения приведены к единой шкале 0–100."] : []),
    ];
    log("complete", "success", `Отчёт готов: ${merged.timeline.length} точек графика и данные связанных запросов для ${request.keywords.length} ключей.`, {
      timelinePoints: merged.timeline.length,
      keywordCount: request.keywords.length,
      relatedCount: merged.related.reduce((total, item) => total + item.top.length + item.rising.length, 0),
    });
    return {
      request,
      countryName: countryName(request.country),
      timeRangeLabel: timeRangeLabels[request.timeRange],
      propertyLabel: propertyLabels[request.property],
      sourceUrl: buildSourceUrl(request),
      comparisonMode: merged.normalized ? "anchor_normalized" : "native",
      timeline: merged.timeline,
      series: merged.series,
      related: merged.related,
      regions: merged.regions,
      warnings,
      logs,
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    log("failed", "error", error instanceof Error ? error.message : "Сбор Google Trends завершился ошибкой.");
    throw error;
  } finally {
    await context?.close().catch(() => undefined);
  }
}
