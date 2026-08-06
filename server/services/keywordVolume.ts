import { createSign } from "node:crypto";
import type {
  GoogleAdsKeywordCredentials,
  KeywordSurferImportRow,
  KeywordVolumeMetric,
  KeywordVolumeRequest,
  KeywordVolumeResponse,
  KeywordVolumeRow,
  KeywordVolumeSource,
  KeywordVolumeSourceResult,
} from "../../src/shared/types.js";

const GOOGLE_ADS_VERSION = "v25";
const GOOGLE_ADS_ROOT = `https://googleads.googleapis.com/${GOOGLE_ADS_VERSION}`;
const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
const sourceLabels: Record<KeywordVolumeSource, string> = {
  google_ads: "Google Keyword Planner",
  keyword_surfer: "Keyword Surfer",
  keywords_for_free: "Keywords For Free",
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

async function googleServiceAccountToken(raw: string): Promise<string> {
  const account = parseGoogleServiceAccount(raw);
  const issuedAt = Math.floor(Date.now() / 1000);
  const tokenUri = account.token_uri || "https://oauth2.googleapis.com/token";
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
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json() as { access_token?: string; error_description?: string; error?: string };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || `Google OAuth вернул HTTP ${response.status}.`);
  }
  return payload.access_token;
}

function googleHeaders(credentials: GoogleAdsKeywordCredentials, accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "developer-token": credentials.developerToken,
    "content-type": "application/json",
    ...(credentials.loginCustomerId ? { "login-customer-id": credentials.loginCustomerId } : {}),
  };
}

async function googleRequest<T>(url: string, body: unknown, headers: Record<string, string>): Promise<T> {
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
    const message = payload && typeof payload === "object"
      ? String(((payload as { error?: { message?: string } }).error?.message) ?? "")
      : "";
    throw new Error(message || `Google Ads API вернул HTTP ${response.status}.`);
  }
  return payload as T;
}

async function googleCountryResource(country: string, headers: Record<string, string>): Promise<string> {
  const englishName = new Intl.DisplayNames(["en"], { type: "region" }).of(country) ?? country;
  const response = await googleRequest<{
    geoTargetConstantSuggestions?: Array<{ geoTargetConstant?: { resourceName?: string; countryCode?: string; targetType?: string } }>;
  }>(`${GOOGLE_ADS_ROOT}/geoTargetConstants:suggest`, {
    locale: "en",
    countryCode: country,
    locationNames: { names: [englishName] },
  }, headers);
  const exact = response.geoTargetConstantSuggestions?.find((item) =>
    item.geoTargetConstant?.countryCode === country && item.geoTargetConstant?.targetType === "Country");
  if (!exact?.geoTargetConstant?.resourceName) throw new Error(`Google Ads не нашёл geo target для ${country}.`);
  return exact.geoTargetConstant.resourceName;
}

async function collectGoogleAds(
  keywords: string[],
  countries: string[],
  credentials: GoogleAdsKeywordCredentials,
): Promise<Map<string, KeywordVolumeMetric>> {
  const accessToken = await googleServiceAccountToken(credentials.serviceAccountJson);
  const headers = googleHeaders(credentials, accessToken);
  const customerId = credentials.customerId.replace(/\D/g, "");
  const metrics = new Map<string, KeywordVolumeMetric>();
  for (const country of countries) {
    const geoTarget = await googleCountryResource(country, headers);
    const payload = await googleRequest<{ results?: GoogleAdsMetricResult[] }>(
      `${GOOGLE_ADS_ROOT}/customers/${customerId}:generateKeywordHistoricalMetrics`,
      {
        keywords,
        geoTargetConstants: [geoTarget],
        keywordPlanNetwork: "GOOGLE_SEARCH",
        language: "languageConstants/1000",
      },
      headers,
    );
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

function keywordRecords(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  for (const value of [record.keywords, record.results, record.data, (record.data as Record<string, unknown> | undefined)?.keywords]) {
    if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  }
  return [];
}

async function collectKeywordsForFree(keywords: string[], countries: string[], apiKey: string): Promise<Map<string, KeywordVolumeMetric>> {
  const all = new Map<string, KeywordVolumeMetric>();
  for (const country of countries) {
    const response = await fetch("https://keywordsforfree.com/api/v1/research", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ keywords, region: `${country.toLowerCase()}-en` }),
      signal: AbortSignal.timeout(45_000),
    });
    const raw = await response.text();
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    if (!response.ok) {
      const error = payload && typeof payload === "object" ? String((payload as Record<string, unknown>).message ?? (payload as Record<string, unknown>).error ?? "") : "";
      throw new Error(error || `Keywords For Free вернул HTTP ${response.status}.`);
    }
    for (const item of keywordRecords(payload)) {
      const keyword = String(item.keyword ?? item.phrase ?? item.text ?? "").trim();
      const volume = Number(item.volume ?? item.search_volume ?? item.searchVolume ?? item.monthly_searches);
      if (!keyword) continue;
      all.set(rowKey(country, keyword), Number.isFinite(volume)
        ? {
          status: "ok",
          volume,
          ...(Number.isFinite(Number(item.cpc)) ? { cpc: Number(item.cpc) } : {}),
          ...(Number.isFinite(Number(item.competition_index ?? item.competition)) ? { competition: Number(item.competition_index ?? item.competition) } : {}),
        }
        : { status: "no_data", message: "Сервис не вернул оценку объёма." });
    }
  }
  return all;
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

function sourceResult(source: KeywordVolumeSource, status: KeywordVolumeSourceResult["status"], message: string, received = 0): KeywordVolumeSourceResult {
  return { source, status, message, received };
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
    try {
      if (source === "google_ads") {
        const credentials = request.credentials?.googleAds;
        if (!credentials?.developerToken || !credentials.customerId || !credentials.serviceAccountJson) {
          sourceResults.push(sourceResult(source, "not_configured", "Добавьте реквизиты Google Ads API в Настройках."));
          continue;
        }
        const received = applyMetrics(rows, source, await collectGoogleAds(request.keywords, request.countries, credentials));
        sourceResults.push(sourceResult(source, received === rows.length ? "completed" : "partial", `Получено ${received} из ${rows.length} значений.`, received));
      } else if (source === "keywords_for_free") {
        const apiKey = request.credentials?.keywordsForFreeApiKey;
        if (!apiKey) {
          sourceResults.push(sourceResult(source, "not_configured", "Добавьте бесплатный API key Keywords For Free в Настройках."));
          continue;
        }
        const received = applyMetrics(rows, source, await collectKeywordsForFree(request.keywords, request.countries, apiKey));
        sourceResults.push(sourceResult(source, received === rows.length ? "completed" : "partial", `Получено ${received} из ${rows.length} значений.`, received));
      } else {
        const received = applyMetrics(rows, source, collectSurfer(request.surferRows ?? []));
        sourceResults.push(sourceResult(source, received === rows.length ? "completed" : "partial", received
          ? `Из CSV получено ${received} из ${rows.length} значений.`
          : "Импортируйте CSV из Keyword Surfer хотя бы для одной страны.", received));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `${sourceLabels[source]} завершился ошибкой.`;
      for (const row of rows) row.metrics[source] = { status: "error", message };
      sourceResults.push(sourceResult(source, "error", message));
    }
  }

  return { rows, sources: sourceResults, createdAt: new Date().toISOString() };
}
