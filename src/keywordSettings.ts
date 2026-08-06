import type { GoogleAdsKeywordCredentials } from "./shared/types";

const STORAGE_KEY = "spyservice-keyword-volume-settings";

export interface KeywordProviderSettings {
  googleAds: GoogleAdsKeywordCredentials;
}

const EMPTY_SETTINGS: KeywordProviderSettings = {
  googleAds: {
    developerToken: "",
    customerId: "",
    loginCustomerId: "",
    serviceAccountJson: "",
  },
};

export function getKeywordProviderSettings(): KeywordProviderSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<KeywordProviderSettings> & { keywordsForFreeApiKey?: unknown };
    const settings = {
      googleAds: { ...EMPTY_SETTINGS.googleAds, ...(parsed.googleAds ?? {}) },
    };
    if ("keywordsForFreeApiKey" in parsed) localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return settings;
  } catch {
    return structuredClone(EMPTY_SETTINGS);
  }
}

export function saveKeywordProviderSettings(settings: KeywordProviderSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    googleAds: {
      developerToken: settings.googleAds.developerToken.trim(),
      customerId: settings.googleAds.customerId.replace(/\D/g, ""),
      loginCustomerId: settings.googleAds.loginCustomerId?.replace(/\D/g, "") ?? "",
      serviceAccountJson: settings.googleAds.serviceAccountJson.trim(),
    },
  }));
}

export function clearKeywordProviderSettings(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function hasGoogleAdsKeywordSettings(): boolean {
  const settings = getKeywordProviderSettings().googleAds;
  return Boolean(settings.developerToken && settings.customerId && settings.serviceAccountJson);
}
