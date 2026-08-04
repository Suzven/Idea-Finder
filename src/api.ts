import type { AdCreative, AdFilters, AdSource, AdsResponse, IntegrationLogDetail, IntegrationLogsResponse, IntegrationLogStatus } from "./shared/types";

export interface ResolvedAdMedia {
  mediaType: "image" | "video";
  mediaUrl: string;
  thumbnailUrl: string;
  advertiserAvatar: string;
}

const clientIdKey = "spyservice-client-id";

function getClientId(): string {
  let clientId = localStorage.getItem(clientIdKey);
  if (!clientId) {
    clientId = crypto.randomUUID();
    localStorage.setItem(clientIdKey, clientId);
  }
  return clientId;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-client-id": getClientId(),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: "Ошибка сети" })) as { error?: string; action?: string };
    const message = [payload.error, payload.action].filter(Boolean).join(" ");
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export async function fetchAds(source: AdSource, filters: AdFilters, cursor?: string): Promise<AdsResponse> {
  const params = new URLSearchParams({ source, limit: "12" });
  Object.entries(filters).forEach(([key, value]) => {
    if (value && value !== "all") params.set(key, value);
  });
  if (cursor) params.set("cursor", cursor);
  return request<AdsResponse>(`/api/ads?${params}`);
}

export async function setFavorite(ad: AdCreative, value: boolean): Promise<void> {
  await request(`/api/favorites/${encodeURIComponent(ad.id)}`, {
    method: value ? "POST" : "DELETE",
    body: value ? JSON.stringify({ source: ad.source }) : undefined,
  });
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
