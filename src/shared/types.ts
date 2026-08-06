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

export interface AIAnalysisLanding {
  adId: string;
  advertiser: string;
  headline?: string;
  cta?: string;
  landingUrl: string;
  screenshotUrl?: string;
}

export interface AIAnalysisResponse {
  collection: CreativeCollection;
  analysis: NicheAnalysis;
  model: string;
  analyzedCount: number;
  totalCount: number;
  warnings: string[];
  landings?: AIAnalysisLanding[];
}

export interface AICreativeNoteItem {
  ad: AdCreative;
  note: string;
}

export interface AIAnalysisReportSummary {
  id: string;
  name: string;
  collectionId?: string;
  collectionName: string;
  model: string;
  analyzedCount: number;
  totalCount: number;
  opportunityScore: number;
  niche: string;
  createdAt: string;
}

export interface AIAnalysisReport extends AIAnalysisReportSummary {
  result: AIAnalysisResponse;
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

export type ReviewSource = "trustpilot" | "capterra" | "softwareadvice" | "producthunt";
export type ReviewSourceStatus = "found" | "not_found" | "blocked" | "error";
export type ReviewSourceProgressState = "queued" | "running" | "completed";

export interface ReviewManualChallenge {
  id: string;
  source: "capterra";
  width: number;
  height: number;
  pageUrl: string;
  expiresAt: string;
}

export interface ReviewSourceProgress {
  source: ReviewSource;
  label: string;
  status: ReviewSourceProgressState;
  outcome?: ReviewSourceStatus;
  activity?: string;
  attempt?: number;
  currentPage?: number;
  reviewsFound?: number;
  pagesCollected?: number;
  challenge?: ReviewManualChallenge;
  operations?: ReviewProgressOperation[];
}

export interface ReviewProgressOperation {
  stage: string;
  message: string;
  at: string;
  elapsedMs: number;
  attempt?: number;
  page?: number;
  reviewsFound?: number;
  url?: string;
}

export interface UserReview {
  id: string;
  source: ReviewSource;
  author: string;
  date?: string;
  title?: string;
  text: string;
  rating?: number;
  maxRating: number;
  reviewUrl?: string;
  page: number;
}

export interface ReviewAttemptLog {
  url: string;
  finalUrl?: string;
  httpStatus?: number;
  title?: string;
  outcome: "loaded" | "found" | "empty" | "not_found" | "blocked" | "error";
  durationMs: number;
  reviewsFound?: number;
  message?: string;
  pagePreview?: string;
}

export interface ReviewBrowserInfo {
  version: string;
  userAgent: string;
  proxy?: string;
}

export interface ReviewProxySettings {
  configured: boolean;
  server: string;
  username: string;
  bypass: string;
  hasPassword: boolean;
  updatedAt?: string;
}

export interface ReviewProxySettingsInput {
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
}

export interface ReviewProxyTestResult {
  ok: boolean;
  externalIp?: string;
  elapsedMs: number;
  message: string;
  proxy?: string;
  browserVersion?: string;
  userAgent?: string;
  logs: ReviewProxyTestLog[];
}

export interface ReviewProxyTestLog {
  stage: "browser" | "proxy" | "request" | "response" | "cleanup";
  status: "started" | "success" | "error";
  message: string;
  elapsedMs: number;
  details?: Record<string, string | number | boolean>;
}

export interface ReviewProxyTestJobResponse {
  jobId: string;
  status: AIAnalysisJobState;
  result?: ReviewProxyTestResult;
  error?: AIAnalysisJobError;
}

export interface ReviewSourceResult {
  source: ReviewSource;
  label: string;
  status: ReviewSourceStatus;
  query: string;
  companyName?: string;
  profileUrl?: string;
  attemptedUrls: string[];
  attempts: ReviewAttemptLog[];
  browser?: ReviewBrowserInfo;
  reviews: UserReview[];
  message?: string;
}

export interface ReviewSearchResponse {
  query: string;
  sources: ReviewSourceResult[];
  totalReviews: number;
  createdAt: string;
}

export interface ReviewSearchJobResponse {
  jobId: string;
  status: AIAnalysisJobState;
  progress?: ReviewSourceProgress[];
  result?: ReviewSearchResponse;
  error?: AIAnalysisJobError;
}

export type KeywordVolumeSource = "google_ads" | "keyword_surfer";
export type KeywordVolumeMetricStatus = "ok" | "no_data" | "error";
export type KeywordVolumeSourceStatus = "completed" | "partial" | "not_configured" | "error";

export interface GoogleAdsKeywordCredentials {
  developerToken: string;
  customerId: string;
  loginCustomerId?: string;
  serviceAccountJson: string;
}

export interface KeywordVolumeCredentials {
  googleAds?: GoogleAdsKeywordCredentials;
}

export interface KeywordSurferImportRow {
  country: string;
  keyword: string;
  volume: number;
  cpc?: number;
}

export interface KeywordSurferExtensionInfo {
  configured: boolean;
  name?: string;
  version?: string;
  updatedAt?: string;
}

export interface KeywordVolumeRequest {
  keywords: string[];
  countries: string[];
  sources: KeywordVolumeSource[];
  credentials?: KeywordVolumeCredentials;
  surferRows?: KeywordSurferImportRow[];
}

export interface KeywordVolumeMetric {
  status: KeywordVolumeMetricStatus;
  volume?: number;
  volumeRange?: string;
  cpc?: number;
  competition?: number;
  message?: string;
}

export interface KeywordVolumeRow {
  keyword: string;
  country: string;
  countryName: string;
  metrics: Partial<Record<KeywordVolumeSource, KeywordVolumeMetric>>;
}

export interface KeywordVolumeSourceResult {
  source: KeywordVolumeSource;
  status: KeywordVolumeSourceStatus;
  message: string;
  received: number;
  logs?: KeywordVolumeLogEntry[];
}

export interface KeywordVolumeLogEntry {
  at: string;
  stage: string;
  status: "info" | "started" | "success" | "error";
  message: string;
  elapsedMs: number;
  details?: Record<string, string | number | boolean>;
}

export interface KeywordVolumeResponse {
  rows: KeywordVolumeRow[];
  sources: KeywordVolumeSourceResult[];
  createdAt: string;
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
