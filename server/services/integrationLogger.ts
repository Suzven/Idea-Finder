import { randomUUID } from "node:crypto";
import { createIntegrationLog, finishIntegrationLog } from "../db.js";

type Provider = "meta" | "tiktok";

interface StartOptions {
  provider: Provider;
  operation: string;
  method: string;
  url: string;
  headers?: HeadersInit | Record<string, string | undefined>;
  body?: unknown;
}

interface FinishOptions {
  responseStatus?: number;
  responseHeaders?: Headers | Record<string, string>;
  responseBody?: unknown;
  parseAttempts?: unknown[];
  error?: unknown;
}

const REDACTED = "[REDACTED]";

function isSensitiveKey(key: string): boolean {
  return /authorization|access[_-]?token|api[_-]?key|client[_-]?secret|password|cookie|set-cookie/i.test(key);
}

function sanitizeString(value: string): string {
  return value
    .replace(/((?:access[_-]?)?token|sig|signature)=([^&\s"'<>]+)/gi, `$1=${REDACTED}`)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, `$1${REDACTED}`)
    .replace(/(["'](?:access[_-]?token|client[_-]?secret|api[_-]?key|signature)["']\s*:\s*["'])[^"']+/gi, `$1${REDACTED}`);
}

export function sanitizeLogValue(value: unknown, key = ""): unknown {
  if (isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item));
  if (value && typeof value === "object") {
    if (value instanceof URLSearchParams) {
      return Object.fromEntries([...value.entries()].map(([entryKey, entryValue]) => [entryKey, sanitizeLogValue(entryValue, entryKey)]));
    }
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitizeLogValue(entryValue, entryKey)]),
    );
  }
  return value;
}

function serialize(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return sanitizeString(value);
  try {
    return JSON.stringify(sanitizeLogValue(value));
  } catch {
    return JSON.stringify({ serializationError: "Значение не удалось сериализовать" });
  }
}

function headersToObject(headers: StartOptions["headers"] | FinishOptions["responseHeaders"]): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export class IntegrationLogger {
  private readonly startedAt = performance.now();
  private id: number | null = null;

  private constructor() {}

  static async start(options: StartOptions): Promise<IntegrationLogger> {
    const logger = new IntegrationLogger();
    logger.id = await createIntegrationLog({
      traceId: randomUUID(),
      provider: options.provider,
      operation: options.operation,
      requestMethod: options.method,
      requestUrl: sanitizeString(options.url),
      requestHeaders: serialize(headersToObject(options.headers)),
      requestBody: serialize(options.body),
    });
    return logger;
  }

  async success(options: Omit<FinishOptions, "error">): Promise<void> {
    await this.finish("success", options);
  }

  async error(error: unknown, options: Omit<FinishOptions, "error"> = {}): Promise<void> {
    await this.finish("error", { ...options, error });
  }

  private async finish(status: "success" | "error", options: FinishOptions): Promise<void> {
    const errorMessage = options.error instanceof Error ? options.error.stack ?? options.error.message
      : options.error === undefined ? undefined : String(options.error);
    await finishIntegrationLog(this.id, {
      status,
      responseStatus: options.responseStatus,
      responseHeaders: serialize(headersToObject(options.responseHeaders)),
      responseBody: serialize(options.responseBody),
      parseAttempts: serialize(options.parseAttempts),
      errorMessage: errorMessage ? sanitizeString(errorMessage) : undefined,
      durationMs: Math.max(0, Math.round(performance.now() - this.startedAt)),
    });
  }
}
