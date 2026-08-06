import { createSign } from "node:crypto";
import type {
  GoogleAdsKeywordCredentials,
  KeywordSurferImportRow,
  KeywordVolumeLogEntry,
  KeywordVolumeMetric,
  KeywordVolumeRequest,
  KeywordVolumeResponse,
  KeywordVolumeRow,
  KeywordVolumeSource,
  KeywordVolumeSourceResult,
} from "../../src/shared/types.js";
import { collectKeywordSurferRows } from "./keywordSurfer.js";

const GOOGLE_ADS_VERSION = "v25";
const GOOGLE_ADS_ROOT = `https://googleads.googleapis.com/${GOOGLE_ADS_VERSION}`;
const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
const sourceLabels: Record<KeywordVolumeSource, string> = {
  google_ads: "Google Keyword Planner",
  keyword_surfer: "Keyword Surfer",
};

interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface GoogleAdsMetricResult {
  text?: string;
  closeVariants?: string[];
  keywordMetrics?: {
    avgMonthlySearches?: string | number;
    competitionIndex?: string | number;
    lowTopOfPageBidMicros?: string | number;
  };
}

type KeywordVolumeLogger = (
  stage: string,
  status: KeywordVolumeLogEntry["status"],
  message: string,
  details?: KeywordVolumeLogEntry["details"],
) => void;

function rowKey(country: string, keyword: string): string {
  return `${country.toUpperCase()}\u0000${keyword.trim().toLocaleLowerCase("en")}`;
}

function countryName(country: string): string {
  try {
    return new Intl.DisplayNames(["ru"], { type: "region" }).of(country) ?? country;
  } catch {
    return country;
  }
}

function encodeBase64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function parseGoogleServiceAccount(raw: string): GoogleServiceAccount {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("JSON сервисного аккаунта Google повреждён.");
  }
  if (!value || typeof value !== "object") throw new Error("JSON сервисного аккаунта Google пуст.");
  const record = value as Record<string, unknown>;
  if (typeof record.client_email !== "string" || typeof record.private_key !== "string") {
    throw new Error("В JSON Google отсутствуют client_email или private_key.");
  }
  return {
    client_email: record.client_email,
    private_key: record.private_key,
    ...(typeof record.token_uri === "string" ? { token_uri: record.token_uri } : {}),
  };
}

function googleErrorDetails(response: Response, payload: unknown, raw: string): Record<string, string | number | boolean> {
  const details: Record<string, string | number | boolean> = {
    httpStatus: response.status,
    statusText: response.statusText || "—",
  };
  const requestId = response.headers.get("request-id") || response.headers.get("x-goog-request-id");
  if (requestId) details.requestId = requestId;
  if (payload && typeof payload === "object") {
    const googleError = (payload as { error?: { code?: number; status?: string; details?: unknown[] } }).error;
    if (googleError?.code !== undefined) details.googleCode = googleError.code;
    if (googleError?.status) details.googleStatus = googleError.status;
    const detailErrors = googleError?.details?.flatMap((detail) => {
      if (!detail || typeof detail !== "object") return [];
      const errors = (detail as { errors?: unknown[] }).errors;
      return Array.isArray(errors) ? errors : [];
    }) ?? [];
    const codes = detailErrors.flatMap((error) => {
      if (!error || typeof error !== "object") return [];
      const code = (error as { errorCode?: Record<string, unknown> }).errorCode;
      return code ? Object.entries(code).map(([key, value]) => `${key}: ${String(value)}`) : [];
    });
    if (codes.length) details.googleAdsError = [...new Set(codes)].join(", ");
  }
  if (raw) details.responsePreview = raw.replace(/\s+/g, " ").slice(0, 6_000);
  return details;
}

async function googleServiceAccountToken(raw: string, log: KeywordVolumeLogger): Promise<string> {
  const account = parseGoogleServiceAccount(raw);
  const issuedAt = Math.floor(Date.now() / 1000);
  const tokenUri = account.token_uri || "https://oauth2.googleapis.com/token";
  log("credentials", "info", "JSON сервисного аккаунта прочитан.", {
    serviceAccount: account.client_email,
    tokenEndpoint: tokenUri,
  });
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = encodeBase64Url(JSON.stringify({
    iss: account.client_email,
    scope: GOOGLE_ADS_SCOPE,
    aud: tokenUri,
    iat: issuedAt,
    exp: issuedAt + 3_600,
  }));
  const unsigned = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(account.private_key).toString("base64url")}`;
  log("oauth", "started", "Запрашиваем OAuth access token у Google.");
  try {
    const response = await fetch(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(30_000),
    });
    const rawResponse = await response.text();
    let payload: { access_token?: string; error_description?: string; error?: string } = {};
    try { payload = JSON.parse(rawResponse) as typeof payload; } catch { /* diagnostic below */ }
    if (!response.ok || !payload.access_token) {
      const message = payload.error_description || payload.error || `Google OAuth вернул HTTP ${response.status}.`;
      log("oauth", "error", message, googleErrorDetails(response, payload, rawResponse));
      throw new Error(message);
    }
    log("oauth", "success", "OAuth access token получен. Сам токен в лог не записан.", { httpStatus: response.status });
    return payload.access_token;
  } catch (error) {
    if (error instanceof Error && !/Google OAuth/.test(error.message)) {
      log("oauth", "error", error.message, { errorType: error.name });
    }
    throw error;
  }
}

function googleHeaders(credentials: GoogleAdsKeywordCredentials, accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "developer-token": credentials.developerToken,
    "content-type": "application/json",
    ...(credentials.loginCustomerId ? { "login-customer-id": credentials.loginCustomerId } : {}),
  };
}

async function googleRequest<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  log: KeywordVolumeLogger,
  stage: string,
  message: string,
  context: KeywordVolumeLogEntry["details"],
): Promise<T> {
  log(stage, "started", message, { endpoint: new URL(url).pathname, ...context });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    const raw = await response.text();
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    if (!response.ok) {
      const googleMessage = payload && typeof payload === "object"
        ? String(((payload as { error?: { message?: string } }).error?.message) ?? "")
        : "";
      const errorMessage = googleMessage || `Google Ads API вернул HTTP ${response.status}.`;
      log(stage, "error", errorMessage, { ...context, ...googleErrorDetails(response, payload, raw) });
      throw new Error(errorMessage);
    }
    log(stage, "success", "Google Ads API ответил успешно.", {
      ...context,
      httpStatus: response.status,
      requestId: response.headers.get("request-id") || response.headers.get("x-goog-request-id") || "—",
    });
    return payload as T;
  } catch (error) {
    if (error instanceof Error && !/Google Ads API|permission|developer token/i.test(error.message)) {
      log(stage, "error", error.message, { ...context, errorType: error.name });
    }
    throw error;
  }
}

async function googleCountryResource(country: string, headers: Record<string, string>, log: KeywordVolumeLogger): Promise<string> {
  const englishName = new Intl.DisplayNames(["en"], { type: "region" }).of(country) ?? country;
  const response = await googleRequest<{
    geoTargetConstantSuggestions?: Array<{ geoTargetConstant?: { resourceName?: string; countryCode?: string; targetType?: string } }>;
  }>(`${GOOGLE_ADS_ROOT}/geoTargetConstants:suggest`, {
    locale: "en",
    countryCode: country,
    locationNames: { names: [englishName] },
  }, headers, log, `geo_${country}`, `Определяем геотаргет для ${country}.`, { country, countryName: englishName });
  const exact = response.geoTargetConstantSuggestions?.find((item) =>
    item.geoTargetConstant?.countryCode === country && item.geoTargetConstant?.targetType === "Country");
  if (!exact?.geoTargetConstant?.resourceName) throw new Error(`Google Ads не нашёл geo target для ${country}.`);
  return exact.geoTargetConstant.resourceName;
}

async function collectGoogleAds(
  keywords: string[],
  countries: string[],
  credentials: GoogleAdsKeywordCredentials,
  log: KeywordVolumeLogger,
): Promise<Map<string, KeywordVolumeMetric>> {
  log("configuration", "info", "Проверяем связку аккаунтов Google Ads.", {
    apiVersion: GOOGLE_ADS_VERSION,
    customerId: credentials.customerId,
    managerId: credentials.loginCustomerId || "не указан",
    keywordCount: keywords.length,
    countryCount: countries.length,
  });
  const accessToken = await googleServiceAccountToken(credentials.serviceAccountJson, log);
  const headers = googleHeaders(credentials, accessToken);
  const customerId = credentials.customerId.replace(/\D/g, "");
  const metrics = new Map<string, KeywordVolumeMetric>();
  for (const country of countries) {
    const geoTarget = await googleCountryResource(country, headers, log);
    const payload = await googleRequest<{ results?: GoogleAdsMetricResult[] }>(
      `${GOOGLE_ADS_ROOT}/customers/${customerId}:generateKeywordHistoricalMetrics`,
      {
        keywords,
        geoTargetConstants: [geoTarget],
        keywordPlanNetwork: "GOOGLE_SEARCH",
        language: "languageConstants/1000",
      },
      headers,
      log,
      `metrics_${country}`,
      `Запрашиваем исторические метрики для ${country}.`,
      { country, customerId, managerId: credentials.loginCustomerId || "не указан", keywordCount: keywords.length },
    );
    log(`metrics_${country}`, "info", `Google вернул ${payload.results?.length ?? 0} строк метрик для ${country}.`, {
      country,
      resultCount: payload.results?.length ?? 0,
    });
    for (const result of payload.results ?? []) {
      const volume = Number(result.keywordMetrics?.avgMonthlySearches);
      const cpcMicros = Number(result.keywordMetrics?.lowTopOfPageBidMicros);
      const metric: KeywordVolumeMetric = Number.isFinite(volume)
        ? {
          status: "ok",
          volume,
          ...(Number.isFinite(cpcMicros) ? { cpc: cpcMicros / 1_000_000 } : {}),
          ...(Number.isFinite(Number(result.keywordMetrics?.competitionIndex))
            ? { competition: Number(result.keywordMetrics?.competitionIndex) }
            : {}),
        }
        : { status: "no_data", message: "Google не вернул объём." };
      for (const phrase of [result.text, ...(result.closeVariants ?? [])]) {
        if (phrase) metrics.set(rowKey(country, phrase), metric);
      }
    }
  }
  return metrics;
}

function collectSurfer(rows: KeywordSurferImportRow[]): Map<string, KeywordVolumeMetric> {
  const metrics = new Map<string, KeywordVolumeMetric>();
  for (const row of rows) {
    metrics.set(rowKey(row.country, row.keyword), {
      status: "ok",
      volume: row.volume,
      ...(row.cpc !== undefined ? { cpc: row.cpc } : {}),
    });
  }
  return metrics;
}

function applyMetrics(rows: KeywordVolumeRow[], source: KeywordVolumeSource, metrics: Map<string, KeywordVolumeMetric>): number {
  let received = 0;
  for (const row of rows) {
    const metric = metrics.get(rowKey(row.country, row.keyword)) ?? { status: "no_data" as const, message: "Нет данных для этого ключа." };
    row.metrics[source] = metric;
    if (metric.status === "ok") received += 1;
  }
  return received;
}

function sourceResult(
  source: KeywordVolumeSource,
  status: KeywordVolumeSourceResult["status"],
  message: string,
  received = 0,
  logs: KeywordVolumeLogEntry[] = [],
): KeywordVolumeSourceResult {
  return { source, status, message, received, ...(logs.length ? { logs } : {}) };
}

export async function collectKeywordVolume(request: KeywordVolumeRequest): Promise<KeywordVolumeResponse> {
  const rows: KeywordVolumeRow[] = request.countries.flatMap((country) => request.keywords.map((keyword) => ({
    keyword,
    country,
    countryName: countryName(country),
    metrics: {},
  })));
  const sourceResults: KeywordVolumeSourceResult[] = [];

  for (const source of request.sources) {
    const startedAt = Date.now();
    const logs: KeywordVolumeLogEntry[] = [];
    const log: KeywordVolumeLogger = (stage, status, message, details) => logs.push({
      at: new Date().toISOString(),
      stage,
      status,
      message,
      elapsedMs: Date.now() - startedAt,
      ...(details ? { details } : {}),
    });
    try {
      if (source === "google_ads") {
        const credentials = request.credentials?.googleAds;
        if (!credentials?.developerToken || !credentials.customerId || !credentials.serviceAccountJson) {
          log("configuration", "error", "Не заполнены обязательные реквизиты Google Ads API.");
          sourceResults.push(sourceResult(source, "not_configured", "Добавьте реквизиты Google Ads API в Настройках.", 0, logs));
          continue;
        }
        const received = applyMetrics(rows, source, await collectGoogleAds(request.keywords, request.countries, credentials, log));
        log("complete", "success", `Сбор Google завершён: получено ${received} из ${rows.length} значений.`);
        sourceResults.push(sourceResult(source, received === rows.length ? "completed" : "partial", `Получено ${received} из ${rows.length} значений.`, received, logs));
      } else {
        const importedRows = request.surferRows?.length
          ? request.surferRows
          : await collectKeywordSurferRows(request.keywords, request.countries, log);
        const received = applyMetrics(rows, source, collectSurfer(importedRows));
        const mode = request.surferRows?.length ? "CSV" : "Chromium";
        log("surfer_complete", received ? "success" : "info", `${mode}: получено ${received} из ${rows.length} значений.`);
        sourceResults.push(sourceResult(source, received === rows.length ? "completed" : "partial", received
          ? `${mode}: получено ${received} из ${rows.length} значений.`
          : "Keyword Surfer не вернул данные. Проверьте лог источника ниже.", received, logs));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `${sourceLabels[source]} завершился ошибкой.`;
      if (!logs.some((entry) => entry.status === "error" && entry.message === message)) {
        log("failed", "error", message, { errorType: error instanceof Error ? error.name : "UnknownError" });
      }
      if (source === "google_ads" && /permission|PERMISSION_DENIED|USER_PERMISSION_DENIED/i.test(message)) {
        const adsError = logs.map((entry) => entry.details?.googleAdsError).find((value) => typeof value === "string");
        if (typeof adsError === "string" && adsError.includes("DEVELOPER_TOKEN_NOT_APPROVED")) {
          log("permission_hint", "info", "Developer token пока работает только с test accounts. Укажите Customer ID тестового клиента из отдельной test manager и Manager ID этой test manager либо запросите Basic Access для боевого аккаунта.", {
            accessRequired: "Basic Access",
            testAccountAllowed: true,
          });
        } else {
          log("permission_hint", "info", "Проверьте: service account добавлен пользователем в Google Ads, Customer ID принадлежит рекламному аккаунту, а Manager ID — управляющему аккаунту с developer token.");
        }
      }
      for (const row of rows) row.metrics[source] = { status: "error", message };
      sourceResults.push(sourceResult(source, "error", message, 0, logs));
    }
  }

  return { rows, sources: sourceResults, createdAt: new Date().toISOString() };
}
