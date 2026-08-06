import type { KeywordSurferImportRow } from "./shared/types";

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

function numericValue(value: string): number | undefined {
  const normalized = value.replace(/[^\d.,-]/g, "").replace(/,(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseKeywordSurferCsv(text: string, country: string): KeywordSurferImportRow[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("В CSV нет строк с ключевыми словами.");
  const counts = [",", ";", "\t"].map((delimiter) => ({ delimiter, count: parseDelimitedLine(lines[0], delimiter).length }));
  const delimiter = counts.sort((left, right) => right.count - left.count)[0].delimiter;
  const headers = parseDelimitedLine(lines[0], delimiter).map((header) => header.toLocaleLowerCase("en").replace(/[^a-zа-я0-9]+/g, " ").trim());
  const keywordIndex = headers.findIndex((header) => /keyword|ключ/.test(header));
  const volumeIndex = headers.findIndex((header) => /search volume|volume|объ.м|частот/.test(header));
  const cpcIndex = headers.findIndex((header) => /cpc|cost per click|цена клика/.test(header));
  if (keywordIndex < 0 || volumeIndex < 0) throw new Error("Не нашёл в CSV колонки Keyword и Search Volume.");
  const unique = new Map<string, KeywordSurferImportRow>();
  for (const line of lines.slice(1)) {
    const cells = parseDelimitedLine(line, delimiter);
    const keyword = cells[keywordIndex]?.trim();
    const volume = numericValue(cells[volumeIndex] ?? "");
    if (!keyword || volume === undefined) continue;
    const cpc = cpcIndex >= 0 ? numericValue(cells[cpcIndex] ?? "") : undefined;
    unique.set(keyword.toLocaleLowerCase("en"), { country, keyword, volume, ...(cpc !== undefined ? { cpc } : {}) });
  }
  if (!unique.size) throw new Error("CSV распознан, но числовые значения объёма не найдены.");
  return [...unique.values()];
}
