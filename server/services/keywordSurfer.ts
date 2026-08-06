import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";
import { chromium } from "playwright";
import type { KeywordSurferExtensionInfo, KeywordSurferImportRow, KeywordVolumeLogEntry } from "../../src/shared/types.js";
import { AppError } from "../errors.js";
import { getMetaChromiumExecutablePath } from "./metaSnapshot.js";

const inflateRawAsync = promisify(inflateRaw);
const EXTENSION_ID = "bafijghppfhdpldihckdcadbcobikaca";
const STORAGE_ROOT = join(homedir(), ".spyservice", "keyword-surfer");
const ACTIVE_EXTENSION = join(STORAGE_ROOT, "active");
const SESSION_ROOT = join(STORAGE_ROOT, "sessions");
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_ARCHIVE_SIZE = 80 * 1024 * 1024;
const MAX_EXTRACTED_SIZE = 200 * 1024 * 1024;
let surferCollectionActive = false;

interface KeywordSurferManifest {
  name?: string;
  version?: string;
  manifest_version?: number;
  content_scripts?: Array<{ js?: string[]; matches?: string[] }>;
}

export type KeywordSurferLogger = (
  stage: string,
  status: KeywordVolumeLogEntry["status"],
  message: string,
  details?: KeywordVolumeLogEntry["details"],
) => void;

interface ZipEntry {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function validateArchiveEntries(entries: string[]): void {
  if (!entries.length || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new AppError(400, "KEYWORD_SURFER_ARCHIVE_INVALID", "Архив расширения пуст или содержит слишком много файлов.");
  }
  for (const entry of entries) {
    const cleaned = entry.replaceAll("\\", "/");
    const normalized = normalize(cleaned).replaceAll("\\", "/");
    if (!cleaned || cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned) || normalized === ".." || normalized.startsWith("../")) {
      throw new AppError(400, "KEYWORD_SURFER_ARCHIVE_UNSAFE", `В ZIP найден небезопасный путь: ${entry.slice(0, 160)}`);
    }
  }
}

function readZipEntries(archive: Buffer): ZipEntry[] {
  const minimumOffset = Math.max(0, archive.length - 65_557);
  let eocdOffset = -1;
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { eocdOffset = offset; break; }
  }
  if (eocdOffset < 0) throw new AppError(400, "KEYWORD_SURFER_ZIP_INVALID", "Файл не является корректным ZIP-архивом.");
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  if (!entryCount || entryCount > MAX_ARCHIVE_ENTRIES) throw new AppError(400, "KEYWORD_SURFER_ARCHIVE_INVALID", "ZIP пуст или содержит слишком много файлов.");
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  let extractedSize = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new AppError(400, "KEYWORD_SURFER_ZIP_INVALID", "Повреждён каталог ZIP-архива.");
    }
    const compression = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    extractedSize += uncompressedSize;
    if (extractedSize > MAX_EXTRACTED_SIZE) throw new AppError(400, "KEYWORD_SURFER_ZIP_BOMB", "Распакованный ZIP превышает безопасный размер 200 МБ.");
    if (![0, 8].includes(compression)) throw new AppError(400, "KEYWORD_SURFER_ZIP_COMPRESSION", `ZIP использует неподдерживаемое сжатие для ${name.slice(0, 120)}.`);
    entries.push({ name, compression, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  validateArchiveEntries(entries.map((entry) => entry.name));
  return entries;
}

async function extractZip(archive: Buffer, target: string): Promise<void> {
  const entries = readZipEntries(archive);
  for (const entry of entries) {
    const relativeName = entry.name.replaceAll("\\", "/").replace(/\/+$/, "");
    if (!relativeName) continue;
    const destination = join(target, ...relativeName.split("/"));
    if (entry.name.endsWith("/")) {
      await mkdir(destination, { recursive: true });
      continue;
    }
    const localOffset = entry.localHeaderOffset;
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new AppError(400, "KEYWORD_SURFER_ZIP_INVALID", `Повреждён файл ${entry.name.slice(0, 120)} в ZIP.`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > archive.length) throw new AppError(400, "KEYWORD_SURFER_ZIP_INVALID", `Данные ${entry.name.slice(0, 120)} обрезаны.`);
    const compressed = archive.subarray(dataStart, dataEnd);
    const content = entry.compression === 0 ? compressed : await inflateRawAsync(compressed);
    if (content.length !== entry.uncompressedSize) throw new AppError(400, "KEYWORD_SURFER_ZIP_INVALID", `Размер ${entry.name.slice(0, 120)} не совпадает с каталогом ZIP.`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, { mode: 0o600 });
  }
}

async function findManifestRoot(directory: string, depth = 0): Promise<string | undefined> {
  if (existsSync(join(directory, "manifest.json"))) return directory;
  if (depth >= 3) return undefined;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = await findManifestRoot(join(directory, entry.name), depth + 1);
    if (found) return found;
  }
  return undefined;
}

async function readManifest(root = ACTIVE_EXTENSION): Promise<KeywordSurferManifest> {
  const raw = await readFile(join(root, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as KeywordSurferManifest;
  const googleScript = manifest.content_scripts?.some((script) => script.js?.includes("injectGoogleKeywordSurfer.js"));
  if (manifest.name !== "Keyword Surfer" || manifest.manifest_version !== 3 || !manifest.version || !googleScript) {
    throw new AppError(400, "KEYWORD_SURFER_EXTENSION_INVALID", "ZIP не похож на актуальное расширение Keyword Surfer для Chrome.");
  }
  return manifest;
}

export async function getKeywordSurferExtensionInfo(): Promise<KeywordSurferExtensionInfo> {
  try {
    const manifest = await readManifest();
    const file = await stat(join(ACTIVE_EXTENSION, "manifest.json"));
    return { configured: true, name: manifest.name, version: manifest.version, updatedAt: file.mtime.toISOString() };
  } catch {
    return { configured: false };
  }
}

export async function installKeywordSurferExtension(archive: Buffer): Promise<KeywordSurferExtensionInfo> {
  if (!archive.length || archive.length > MAX_ARCHIVE_SIZE) {
    throw new AppError(400, "KEYWORD_SURFER_ARCHIVE_SIZE", "ZIP Keyword Surfer пуст или превышает 80 МБ.");
  }
  await mkdir(STORAGE_ROOT, { recursive: true });
  const id = randomUUID();
  const extractionPath = join(STORAGE_ROOT, `extract-${id}`);
  await mkdir(extractionPath, { recursive: true });
  try {
    await extractZip(archive, extractionPath);
    const manifestRoot = await findManifestRoot(extractionPath);
    if (!manifestRoot) throw new AppError(400, "KEYWORD_SURFER_MANIFEST_MISSING", "В ZIP не найден manifest.json расширения.");
    await readManifest(manifestRoot);
    await rm(ACTIVE_EXTENSION, { recursive: true, force: true });
    await rename(manifestRoot, ACTIVE_EXTENSION);
    return await getKeywordSurferExtensionInfo();
  } finally {
    await rm(extractionPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function deleteKeywordSurferExtension(): Promise<void> {
  await rm(ACTIVE_EXTENSION, { recursive: true, force: true });
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export function parseKeywordSurferPayload(payload: unknown, country: string, requested: string[]): KeywordSurferImportRow[] {
  if (!payload || typeof payload !== "object") return [];
  const entries = Object.entries(payload as Record<string, unknown>);
  const normalized = new Map(entries.map(([keyword, value]) => [keyword.trim().toLocaleLowerCase("en"), value]));
  return requested.flatMap((keyword) => {
    const value = normalized.get(keyword.trim().toLocaleLowerCase("en"));
    if (!value || typeof value !== "object") return [];
    const metric = value as Record<string, unknown>;
    const volume = Number(metric.search_volume ?? metric.searchVolume ?? metric.volume);
    if (!Number.isFinite(volume)) return [];
    const cpc = metric.cpc === null || metric.cpc === undefined || metric.cpc === "" ? Number.NaN : Number(metric.cpc);
    return [{
      country,
      keyword,
      volume,
      ...(Number.isFinite(cpc) ? { cpc } : {}),
    }];
  });
}

export async function collectKeywordSurferRows(
  keywords: string[],
  countries: string[],
  log: KeywordSurferLogger,
): Promise<KeywordSurferImportRow[]> {
  if (surferCollectionActive) {
    throw new AppError(429, "KEYWORD_SURFER_BUSY", "Keyword Surfer уже собирает другой запрос. Дождитесь его завершения.");
  }
  surferCollectionActive = true;
  const sessionPath = join(SESSION_ROOT, randomUUID());
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    const info = await getKeywordSurferExtensionInfo();
    if (!info.configured) {
      throw new AppError(400, "KEYWORD_SURFER_EXTENSION_REQUIRED", "Загрузите ZIP расширения Keyword Surfer в Настройках → Ключи.");
    }
    const executablePath = getMetaChromiumExecutablePath();
    await mkdir(sessionPath, { recursive: true });
    log("surfer_extension", "info", "Расширение Keyword Surfer найдено на сервере.", {
      version: info.version || "—",
      extensionId: EXTENSION_ID,
      chromium: basename(executablePath),
    });
    context = await chromium.launchPersistentContext(sessionPath, {
      headless: true,
      executablePath,
      locale: "en-US",
      viewport: { width: 1440, height: 1000 },
      args: [
        `--disable-extensions-except=${ACTIVE_EXTENSION}`,
        `--load-extension=${ACTIVE_EXTENSION}`,
      ],
    });
    log("surfer_browser", "started", "Chromium запущен с расширением Keyword Surfer.");
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const runtimeId = await popup.evaluate(() => {
      const extensionChrome = (globalThis as unknown as { chrome?: { runtime?: { id?: string } } }).chrome;
      return extensionChrome?.runtime?.id || "";
    });
    if (runtimeId !== EXTENSION_ID) throw new Error("Chromium запустился, но Keyword Surfer не активировался.");
    log("surfer_browser", "success", "Keyword Surfer активирован в Chromium.", { runtimeId });

    const rows: KeywordSurferImportRow[] = [];
    for (const country of countries) {
      log(`surfer_${country}`, "started", `Получаем объёмы Keyword Surfer для ${country}.`, { country, keywordCount: keywords.length });
      await popup.evaluate(async (location) => {
        const extensionChrome = (globalThis as unknown as {
          chrome: { storage: { sync: { get: (keys: string[]) => Promise<Record<string, unknown>>; set: (items: Record<string, unknown>) => Promise<void> } } };
        }).chrome;
        const stored = await extensionChrome.storage.sync.get(["options"]);
        const options = stored.options && typeof stored.options === "object" ? stored.options as Record<string, unknown> : {};
        await extensionChrome.storage.sync.set({ options: { ...options, location: location.toLowerCase(), language: "en" } });
      }, country);

      const endpoints = chunks(keywords, 5).map((group) => {
        const url = new URL("https://db3.keywordsur.fr/api/ks/keywords");
        url.searchParams.set("country", country.toUpperCase());
        url.searchParams.set("keywords", JSON.stringify(group));
        return { url: url.toString(), keywords: group };
      });
      const responses = await popup.evaluate(async (requests) => Promise.all(requests.map(async (request) => {
        try {
          const response = await fetch(request.url, { method: "GET", cache: "no-store" });
          return { ok: response.ok, status: response.status, text: await response.text(), keywords: request.keywords };
        } catch (error) {
          return { ok: false, status: 0, text: error instanceof Error ? error.message : String(error), keywords: request.keywords };
        }
      })), endpoints);

      let countryCount = 0;
      for (const response of responses) {
        if (!response.ok) {
          log(`surfer_${country}`, "error", `Keyword Surfer вернул HTTP ${response.status || "без ответа"}.`, {
            country,
            responsePreview: response.text.replace(/\s+/g, " ").slice(0, 1_500),
          });
          continue;
        }
        let payload: unknown;
        try { payload = JSON.parse(response.text); } catch { payload = null; }
        const parsed = parseKeywordSurferPayload(payload, country, response.keywords);
        rows.push(...parsed);
        countryCount += parsed.length;
      }
      log(`surfer_${country}`, countryCount ? "success" : "error", `Keyword Surfer: ${countryCount} из ${keywords.length} значений для ${country}.`, {
        country,
        received: countryCount,
      });
    }
    return rows;
  } finally {
    await context?.close().catch(() => undefined);
    await rm(sessionPath, { recursive: true, force: true }).catch(() => undefined);
    surferCollectionActive = false;
  }
}
