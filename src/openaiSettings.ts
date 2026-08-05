const OPENAI_KEY_STORAGE = "spyservice-openai-api-key";

export function getOpenAIKey(): string {
  return localStorage.getItem(OPENAI_KEY_STORAGE)?.trim() ?? "";
}

export function saveOpenAIKey(value: string): void {
  const key = value.trim();
  if (key) localStorage.setItem(OPENAI_KEY_STORAGE, key);
  else localStorage.removeItem(OPENAI_KEY_STORAGE);
}

export function hasOpenAIKey(): boolean {
  return Boolean(getOpenAIKey());
}
