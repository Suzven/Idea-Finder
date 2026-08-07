import type { AdCreative, AdFilters, AdSource, AdsResponse, AIAnalysisJobResponse, AIAnalysisReport, AIAnalysisReportSummary, AIAnalysisResponse, AICreativeNoteItem, AuthSessionResponse, CreativeCollection, GoogleTrendsJobResponse, GoogleTrendsProgress, GoogleTrendsReport, GoogleTrendsRequest, IntegrationLogDetail, IntegrationLogsResponse, IntegrationLogStatus, KeywordSurferExtensionInfo, KeywordVolumeRequest, KeywordVolumeResponse, LegacyBrowserImport, PrivateSettingsInput, PrivateSettingsSummary, ReviewProxySettings, ReviewProxySettingsInput, ReviewProxyTestJobResponse, ReviewProxyTestResult, ReviewSearchJobResponse, ReviewSearchResponse, ReviewSource, ReviewSourceProgress, ThreadsConversationResponse, ThreadsOAuthStartResponse, ThreadsPost, ThreadsSearchRequest, ThreadsSearchResponse } from "./shared/types";

export interface ResolvedAdMedia {
  mediaType: "image" | "video";
  mediaUrl: string;
  thumbnailUrl: string;
  advertiserAvatar: string;
  landingUrl?: string;
  cta?: string;
}

const clientIdKey = "spyservice-client-id";

interface ApiErrorPayload {
  error?: string;
  code?: string;
  action?: string;
  traceId?: string;
  details?: Record<string, unknown>;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code = "REQUEST_FAILED",
    public readonly action?: string,
    public readonly traceId?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function getLegacyClientId(): string {
  let clientId = localStorage.getItem(clientIdKey);
  if (!clientId) {
    clientId = crypto.randomUUID();
    localStorage.setItem(clientIdKey, clientId);
  }
  return clientId;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch (error) {
    const cause = error instanceof Error ? error : new Error("unknown network error");
    throw new ApiRequestError(
      "Браузер не смог подключиться к серверу приложения.",
      0,
      "NETWORK_ERROR",
      "Проверьте интернет-соединение и доступность сайта.",
      undefined,
      { endpoint: url, cause: cause.name, message: cause.message },
    );
  }
  if (!response.ok) {
    if (response.status === 401 && url !== "/api/auth/me" && url !== "/api/auth/login") {
      window.dispatchEvent(new Event("spyservice:unauthorized"));
    }
    const rawBody = await response.text();
    let payload: ApiErrorPayload;
    try {
      payload = JSON.parse(rawBody) as ApiErrorPayload;
    } catch {
      payload = {
        error: "Сервер вернул ответ в неожиданном формате.",
        code: "NON_JSON_RESPONSE",
        details: {
          endpoint: url,
          httpStatus: response.status,
          statusText: response.statusText,
          contentType: response.headers.get("content-type"),
          responsePreview: rawBody.replace(/\s+/g, " ").slice(0, 500),
        },
      };
    }
    throw new ApiRequestError(
      payload.error || `HTTP ${response.status}`,
      response.status,
      payload.code,
      payload.action,
      payload.traceId,
      payload.details,
    );
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export async function fetchCurrentSession(): Promise<AuthSessionResponse> {
  return request<AuthSessionResponse>("/api/auth/me", { cache: "no-store" });
}

export async function login(username: string, password: string, legacy?: LegacyBrowserImport): Promise<AuthSessionResponse> {
  return request<AuthSessionResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password, ...(legacy ? { legacy } : {}) }),
  });
}

export async function logout(): Promise<void> {
  await request("/api/auth/logout", { method: "POST" });
}

export async function fetchPrivateSettings(): Promise<PrivateSettingsSummary> {
  return request<PrivateSettingsSummary>("/api/settings/private", { cache: "no-store" });
}

export async function savePrivateSettings(settings: PrivateSettingsInput): Promise<PrivateSettingsSummary> {
  return request<PrivateSettingsSummary>("/api/settings/private", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function startThreadsOAuth(): Promise<ThreadsOAuthStartResponse> {
  return request<ThreadsOAuthStartResponse>("/api/threads/oauth/start", { method: "POST" });
}

export async function searchThreadsPosts(payload: ThreadsSearchRequest): Promise<ThreadsSearchResponse> {
  return request<ThreadsSearchResponse>("/api/threads/search", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchThreadsConversation(post: ThreadsPost): Promise<ThreadsConversationResponse> {
  return request<ThreadsConversationResponse>("/api/threads/conversation", {
    method: "POST",
    body: JSON.stringify({ post }),
  });
}

export async function fetchAds(source: AdSource, filters: AdFilters, cursor?: string): Promise<AdsResponse> {
  const params = new URLSearchParams({ source, limit: "12" });
  Object.entries(filters).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(","));
    } else if (value && value !== "all") {
      params.set(key, value);
    }
  });
  if (cursor) params.set("cursor", cursor);
  return request<AdsResponse>(`/api/ads?${params}`);
}

export async function fetchFavoriteAds(collectionId?: string): Promise<AdsResponse> {
  const params = collectionId ? `?collectionId=${encodeURIComponent(collectionId)}` : "";
  return request<AdsResponse>(`/api/favorites${params}`);
}

export async function setFavorite(ad: AdCreative, value: boolean, collectionId?: string): Promise<void> {
  await request(`/api/favorites/${encodeURIComponent(ad.id)}`, {
    method: value ? "POST" : "DELETE",
    body: value ? JSON.stringify({ source: ad.source, ad, collectionId }) : undefined,
  });
}

export async function fetchCollections(): Promise<CreativeCollection[]> {
  const response = await request<{ items: CreativeCollection[] }>("/api/collections");
  return response.items;
}

export async function createCollection(name: string): Promise<CreativeCollection> {
  return request<CreativeCollection>("/api/collections", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function deleteCollection(collectionId: string): Promise<{ ok: true; deletedFavorites: number }> {
  return request<{ ok: true; deletedFavorites: number }>(`/api/collections/${encodeURIComponent(collectionId)}`, {
    method: "DELETE",
  });
}

export async function analyzeCreativeCollection(collectionId: string, apiKey?: string): Promise<AIAnalysisResponse> {
  const started = await request<AIAnalysisJobResponse>("/api/ai-analysis", {
    method: "POST",
    ...(apiKey ? { headers: { "x-openai-api-key": apiKey } } : {}),
    body: JSON.stringify({ collectionId }),
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15 * 60_000) {
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
    const job = await request<AIAnalysisJobResponse>(`/api/ai-analysis/jobs/${encodeURIComponent(started.jobId)}`);
    if (job.status === "completed" && job.result) return job.result;
    if (job.status === "failed" && job.error) {
      throw new ApiRequestError(
        job.error.message,
        job.error.httpStatus,
        job.error.code,
        job.error.action,
        job.error.traceId,
        job.error.details,
      );
    }
  }
  throw new ApiRequestError(
    "AI-анализ выполняется слишком долго.",
    504,
    "AI_ANALYSIS_TIMEOUT",
    "Повторите запрос позже. Фоновая задача на сервере могла продолжить выполнение.",
    started.jobId,
  );
}

export async function fetchAIAnalysisCreatives(collectionId: string): Promise<AICreativeNoteItem[]> {
  const response = await request<{ items: AICreativeNoteItem[] }>(`/api/ai-analysis/creatives/${encodeURIComponent(collectionId)}`);
  return response.items;
}

export async function saveCreativeAnalysisNotes(collectionId: string, adIds: string[], note: string): Promise<number> {
  const response = await request<{ ok: true; updated: number }>("/api/ai-analysis/creative-notes", {
    method: "PUT",
    body: JSON.stringify({ collectionId, adIds, note }),
  });
  return response.updated;
}

export async function fetchAIAnalysisReports(): Promise<AIAnalysisReportSummary[]> {
  const response = await request<{ items: AIAnalysisReportSummary[] }>("/api/ai-analysis/reports");
  return response.items;
}

export async function fetchAIAnalysisReport(reportId: string): Promise<AIAnalysisReport> {
  return request<AIAnalysisReport>(`/api/ai-analysis/reports/${encodeURIComponent(reportId)}`);
}

export async function deleteAIAnalysisReport(reportId: string): Promise<void> {
  await request(`/api/ai-analysis/reports/${encodeURIComponent(reportId)}`, { method: "DELETE" });
}

export async function searchCompanyReviews(
  query: string,
  sources: ReviewSource[],
  onProgress?: (progress: ReviewSourceProgress[]) => void,
): Promise<ReviewSearchResponse> {
  const started = await request<ReviewSearchJobResponse>("/api/review-analysis", {
    method: "POST",
    body: JSON.stringify({ query, sources }),
  });
  onProgress?.(started.progress ?? []);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20 * 60_000) {
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
    const job = await request<ReviewSearchJobResponse>(`/api/review-analysis/jobs/${encodeURIComponent(started.jobId)}`);
    onProgress?.(job.progress ?? []);
    if (job.status === "completed" && job.result) return job.result;
    if (job.status === "failed" && job.error) {
      throw new ApiRequestError(
        job.error.message,
        job.error.httpStatus,
        job.error.code,
        job.error.action,
        job.error.traceId,
        job.error.details,
      );
    }
  }
  throw new ApiRequestError(
    "Поиск отзывов выполняется слишком долго.",
    504,
    "REVIEW_ANALYSIS_TIMEOUT",
    "Повторите запрос позже: фоновая задача на сервере могла продолжить выполнение.",
    started.jobId,
  );
}

export function clearLegacyClientId(): void {
  localStorage.removeItem(clientIdKey);
}

export async function collectKeywordVolumes(payload: KeywordVolumeRequest): Promise<KeywordVolumeResponse> {
  return request<KeywordVolumeResponse>("/api/keyword-volume", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function collectGoogleTrendsReport(
  payload: GoogleTrendsRequest,
  onProgress?: (progress: GoogleTrendsProgress) => void,
): Promise<GoogleTrendsReport> {
  const started = await request<GoogleTrendsJobResponse>("/api/google-trends", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  onProgress?.(started.progress ?? { stage: "queued", activity: "Отчёт поставлен в очередь.", completedSteps: 0, totalSteps: 1, logs: [] });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10 * 60_000) {
    await new Promise((resolve) => window.setTimeout(resolve, 1_500));
    const job = await request<GoogleTrendsJobResponse>(`/api/google-trends/jobs/${encodeURIComponent(started.jobId)}`);
    if (job.progress) onProgress?.(job.progress);
    if (job.status === "completed" && job.result) return job.result;
    if (job.status === "failed" && job.error) {
      throw new ApiRequestError(
        job.error.message,
        job.error.httpStatus,
        job.error.code,
        job.error.action,
        job.error.traceId,
        job.error.details,
      );
    }
  }
  throw new ApiRequestError(
    "Сбор Google Trends выполняется слишком долго.",
    504,
    "GOOGLE_TRENDS_TIMEOUT",
    "Повторите запрос позже: фоновая задача на сервере могла продолжить выполнение.",
    started.jobId,
  );
}

export async function fetchKeywordSurferExtensionInfo(): Promise<KeywordSurferExtensionInfo> {
  return request<KeywordSurferExtensionInfo>("/api/settings/keyword-surfer-extension", { cache: "no-store" });
}

export async function uploadKeywordSurferExtension(file: File): Promise<KeywordSurferExtensionInfo> {
  return request<KeywordSurferExtensionInfo>("/api/settings/keyword-surfer-extension", {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: file,
  });
}

export async function removeKeywordSurferExtension(): Promise<void> {
  await request("/api/settings/keyword-surfer-extension", { method: "DELETE" });
}

export async function fetchReviewChallengeFrame(challengeId: string): Promise<Blob> {
  const response = await fetch(`/api/review-analysis/challenges/${encodeURIComponent(challengeId)}/frame`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new ApiRequestError(
      response.status === 409 ? "Chromium обновляет страницу." : "Кадр ручной проверки уже недоступен.",
      response.status,
      response.status === 409 ? "REVIEW_CHALLENGE_FRAME_BUSY" : "REVIEW_CHALLENGE_FRAME_FAILED",
    );
  }
  return response.blob();
}

export async function clickReviewChallenge(challengeId: string, x: number, y: number): Promise<void> {
  await request(`/api/review-analysis/challenges/${encodeURIComponent(challengeId)}/click`, {
    method: "POST",
    body: JSON.stringify({ x, y }),
  });
}

export async function scrollReviewChallenge(challengeId: string, deltaY: number): Promise<void> {
  await request(`/api/review-analysis/challenges/${encodeURIComponent(challengeId)}/scroll`, {
    method: "POST",
    body: JSON.stringify({ deltaY }),
  });
}

export async function cancelReviewChallenge(challengeId: string): Promise<void> {
  await request(`/api/review-analysis/challenges/${encodeURIComponent(challengeId)}`, { method: "DELETE" });
}

export async function fetchReviewProxySettings(): Promise<ReviewProxySettings> {
  return request<ReviewProxySettings>("/api/settings/review-proxy");
}

export async function saveReviewProxyConfiguration(settings: ReviewProxySettingsInput): Promise<ReviewProxySettings> {
  return request<ReviewProxySettings>("/api/settings/review-proxy", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function deleteReviewProxyConfiguration(): Promise<void> {
  await request("/api/settings/review-proxy", { method: "DELETE" });
}

export async function testReviewProxyConfiguration(): Promise<ReviewProxyTestResult> {
  const started = await request<ReviewProxyTestJobResponse>("/api/settings/review-proxy/test", { method: "POST" });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2 * 60_000) {
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    const job = await request<ReviewProxyTestJobResponse>(`/api/settings/review-proxy/test/${encodeURIComponent(started.jobId)}`);
    if (job.status === "completed" && job.result) return job.result;
    if (job.status === "failed" && job.error) {
      throw new ApiRequestError(
        job.error.message,
        job.error.httpStatus,
        job.error.code,
        job.error.action,
        job.error.traceId,
        job.error.details,
      );
    }
  }
  throw new ApiRequestError(
    "Проверка прокси выполняется слишком долго.",
    504,
    "REVIEW_PROXY_TEST_TIMEOUT",
    "Повторите проверку позже. Фоновая задача на сервере могла продолжить выполнение.",
    started.jobId,
  );
}

export async function fetchAdMedia(mediaInfoUrl: string): Promise<ResolvedAdMedia> {
  return request<ResolvedAdMedia>(mediaInfoUrl);
}

export async function fetchIntegrationLogs(filters: {
  provider?: AdSource;
  status?: IntegrationLogStatus;
  search?: string;
  offset?: number;
  limit?: number;
}): Promise<IntegrationLogsResponse> {
  const params = new URLSearchParams({
    limit: String(filters.limit ?? 25),
    offset: String(filters.offset ?? 0),
  });
  if (filters.provider) params.set("provider", filters.provider);
  if (filters.status) params.set("status", filters.status);
  if (filters.search) params.set("search", filters.search);
  return request<IntegrationLogsResponse>(`/api/integration-logs?${params}`);
}

export async function fetchIntegrationLog(id: number): Promise<IntegrationLogDetail> {
  return request<IntegrationLogDetail>(`/api/integration-logs/${id}`);
}

export async function clearIntegrationLogs(): Promise<{ ok: true; deleted: number }> {
  return request<{ ok: true; deleted: number }>("/api/integration-logs", { method: "DELETE" });
}
