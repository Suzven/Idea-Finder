export type AdSource = "meta" | "tiktok";
export type MediaType = "image" | "video" | "carousel";

export interface AdCreative {
  id: string;
  source: AdSource;
  advertiser: string;
  advertiserAvatar?: string;
  country: string;
  countryName: string;
  countries?: string[];
  platforms: string[];
  mediaType: MediaType;
  mediaUrl: string;
  thumbnailUrl: string;
  mediaInfoUrl?: string;
  carousel?: string[];
  headline: string;
  body: string;
  cta: string;
  landingUrl?: string;
  sourceUrl?: string;
  startedAt: string;
  endedAt?: string;
  daysActive: number;
  reach?: number;
  savedCount: number;
  language: string;
  appUrl?: string;
  isFavorite?: boolean;
}

export interface AdsResponse {
  items: AdCreative[];
  nextCursor: string | null;
  total: number;
  mode: "demo" | "live";
  limitations?: string[];
}

export interface CreativeCollection {
  id: string;
  name: string;
  itemCount: number;
  createdAt: string;
}

export interface AICreativeFinding {
  adId: string;
  advertiser: string;
  verdict: string;
  evidence: string[];
  improvements: string[];
}

export interface AITestIdea {
  priority: "high" | "medium" | "low";
  hypothesis: string;
  creativeAngle: string;
  offer: string;
}

export interface NicheAnalysis {
  niche: string;
  executiveSummary: string;
  opportunityScore: number;
  confidence: "high" | "medium" | "low";
  demandSignals: string[];
  winningPatterns: string[];
  audienceInsights: string[];
  landingInsights: string[];
  risks: string[];
  recommendations: string[];
  testPlan: AITestIdea[];
  creativeFindings: AICreativeFinding[];
  caveats: string[];
}

export interface AIAnalysisResponse {
  collection: CreativeCollection;
  analysis: NicheAnalysis;
  model: string;
  analyzedCount: number;
  totalCount: number;
  warnings: string[];
}

export type AIAnalysisJobState = "queued" | "running" | "completed" | "failed";

export interface AIAnalysisJobError {
  message: string;
  code: string;
  httpStatus: number;
  action?: string;
  traceId: string;
  details?: Record<string, unknown>;
}

export interface AIAnalysisJobResponse {
  jobId: string;
  status: AIAnalysisJobState;
  result?: AIAnalysisResponse;
  error?: AIAnalysisJobError;
}

export type IntegrationLogStatus = "started" | "success" | "error";

export interface IntegrationLogSummary {
  id: number;
  traceId: string;
  provider: AdSource;
  operation: string;
  status: IntegrationLogStatus;
  requestMethod: string;
  requestUrl: string;
  responseStatus: number | null;
  responsePreview: string | null;
  parseAttemptsCount: number;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface IntegrationLogDetail extends IntegrationLogSummary {
  requestHeaders: string | null;
  requestBody: string | null;
  responseHeaders: string | null;
  responseBody: string | null;
  parseAttempts: string | null;
  completedAt: string | null;
}

export interface IntegrationLogsResponse {
  items: IntegrationLogSummary[];
  total: number;
  databaseEnabled: boolean;
  stats: {
    success: number;
    errors: number;
    inProgress: number;
    averageDurationMs: number;
  };
}

export interface AdFilters {
  search: string;
  searchMode: "all" | "exact" | "media";
  country: string[];
  app: string;
  mediaType: "all" | MediaType;
  language: string[];
  dateFrom: string;
  dateTo: string;
  platform: string;
  reachFrom: string;
  reachTo: string;
  advertiser: string;
  durationFrom: string;
  durationTo: string;
  savedFrom: string;
  savedTo: string;
}

export const EMPTY_FILTERS: AdFilters = {
  search: "sale",
  searchMode: "all",
  country: ["US"],
  app: "",
  mediaType: "all",
  language: [],
  dateFrom: "",
  dateTo: "",
  platform: "",
  reachFrom: "",
  reachTo: "",
  advertiser: "",
  durationFrom: "",
  durationTo: "",
  savedFrom: "",
  savedTo: "",
};
