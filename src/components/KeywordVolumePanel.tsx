import { AlertTriangle, BarChart3, Check, CheckCircle2, ChevronDown, CircleGauge, Copy, FileDown, Globe2, KeyRound, LoaderCircle, Plus, Search, Settings2, Table2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, collectKeywordVolumes, fetchKeywordSurferExtensionInfo, fetchPrivateSettings } from "../api";
import { parseKeywordSurferCsv } from "../keywordSurferCsv";
import { META_COUNTRIES } from "../shared/filterOptions";
import type { FilterOption } from "../shared/filterOptions";
import type { KeywordSurferExtensionInfo, KeywordSurferImportRow, KeywordVolumeMetric, KeywordVolumeResponse, KeywordVolumeSource, KeywordVolumeSourceResult } from "../shared/types";

interface KeywordVolumePanelProps {
  onOpenSettings: () => void;
  settingsRevision: number;
}

const sourceInfo: Record<KeywordVolumeSource, { label: string; caption: string; icon: typeof BarChart3 }> = {
  google_ads: { label: "Google Keyword Planner", caption: "Точные исторические метрики Google Ads", icon: BarChart3 },
  keyword_surfer: { label: "Keyword Surfer", caption: "Автосбор из источника расширения · CSV как резерв", icon: CircleGauge },
};

function CountryPicker({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const options = useMemo(() => META_COUNTRIES.filter((option) => option.value !== "ALL"), []);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const visible = options.filter((option) => `${option.label} ${option.value}`.toLocaleLowerCase("ru").includes(query.trim().toLocaleLowerCase("ru")));
  const labels = value.map((code) => options.find((option) => option.value === code)?.label ?? code);
  const toggle = (option: FilterOption) => {
    if (value.includes(option.value)) onChange(value.filter((code) => code !== option.value));
    else if (value.length < 20) onChange([...value, option.value]);
  };
  return <div className={`keyword-country-picker ${open ? "open" : ""}`} ref={rootRef}>
    <button type="button" onClick={() => setOpen((current) => !current)}><Globe2 size={17} /><span>{labels.length ? labels.length === 1 ? labels[0] : `${labels[0]} +${labels.length - 1}` : "Выберите страны"}</span>{value.length > 0 && <b>{value.length}</b>}<ChevronDown size={16} /></button>
    {open && <div className="keyword-country-menu">
      <label><Search size={15} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Страна или ISO-код" /></label>
      <header><span>Выбрано {value.length} из 20</span>{value.length > 0 && <button type="button" onClick={() => onChange([])}>Сбросить</button>}</header>
      <div>{visible.map((option) => <button type="button" key={option.value} className={value.includes(option.value) ? "selected" : ""} onClick={() => toggle(option)}><i>{value.includes(option.value) && <Check size={13} />}</i><span>{option.label}</span><small>{option.value}</small></button>)}</div>
    </div>}
  </div>;
}

function formatVolume(value?: number): string {
  return value === undefined ? "—" : new Intl.NumberFormat("ru-RU").format(value);
}

function metricCell(metric?: KeywordVolumeMetric) {
  if (!metric || metric.status === "no_data") return <span className="keyword-volume-empty" title={metric?.message}>н/д</span>;
  if (metric.status === "error") return <span className="keyword-volume-error" title={metric.message}>ошибка</span>;
  return <span className="keyword-volume-value"><strong>{formatVolume(metric.volume)}</strong>{metric.cpc !== undefined && <small>CPC ${metric.cpc.toFixed(2)}</small>}</span>;
}

function sourceLogText(source: KeywordVolumeSourceResult): string {
  return (source.logs ?? []).map((entry) => {
    const details = entry.details ? `\n${Object.entries(entry.details).map(([key, value]) => `${key}: ${value}`).join("\n")}` : "";
    return `[+${entry.elapsedMs} ms] ${entry.status.toUpperCase()} · ${entry.stage}\n${entry.message}${details}`;
  }).join("\n\n");
}

function SourceDiagnostics({ source }: { source: KeywordVolumeSourceResult }) {
  if (!source.logs?.length) return null;
  return <details className={`keyword-source-diagnostics ${source.status}`} open={source.status === "error"}>
    <summary><span>Лог {sourceInfo[source.source].label}</span><small>{source.logs.length} событий</small></summary>
    <div className="keyword-source-log-toolbar"><span>Токены и приватный ключ сюда не записываются.</span><button type="button" onClick={() => void navigator.clipboard.writeText(sourceLogText(source))}><Copy size={13} />Копировать лог</button></div>
    <ol>{source.logs.map((entry, index) => <li className={entry.status} key={`${entry.at}-${entry.stage}-${index}`}>
      <time>+{entry.elapsedMs} мс</time>
      <div><strong>{entry.stage}</strong><p>{entry.message}</p>{entry.details && <dl>{Object.entries(entry.details).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>}</div>
    </li>)}</ol>
  </details>;
}

export function KeywordVolumePanel({ onOpenSettings, settingsRevision }: KeywordVolumePanelProps) {
  const [draft, setDraft] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [countries, setCountries] = useState<string[]>(["US"]);
  const [sources, setSources] = useState<KeywordVolumeSource[]>(["google_ads", "keyword_surfer"]);
  const [surferRows, setSurferRows] = useState<KeywordSurferImportRow[]>([]);
  const [importCountry, setImportCountry] = useState("US");
  const [importMessage, setImportMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<KeywordVolumeResponse | null>(null);
  const [surferExtension, setSurferExtension] = useState<KeywordSurferExtensionInfo>({ configured: false });
  const [googleConfigured, setGoogleConfigured] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchPrivateSettings()
      .then((settings) => { if (!cancelled) setGoogleConfigured(settings.googleAds.configured); })
      .catch(() => { if (!cancelled) setGoogleConfigured(false); });
    void fetchKeywordSurferExtensionInfo()
      .then((info) => { if (!cancelled) setSurferExtension(info); })
      .catch(() => { if (!cancelled) setSurferExtension({ configured: false }); });
    return () => { cancelled = true; };
  }, [settingsRevision]);

  useEffect(() => {
    if (!countries.includes(importCountry)) setImportCountry(countries[0] ?? "");
  }, [countries, importCountry]);

  const addKeywords = () => {
    const additions = draft.split(/[\n,]/).map((value) => value.trim().replace(/\s+/g, " ")).filter(Boolean);
    if (!additions.length) return;
    setKeywords((current) => [...new Map([...current, ...additions].map((keyword) => [keyword.toLocaleLowerCase("en"), keyword])).values()].slice(0, 30));
    setDraft("");
    setResult(null);
  };

  const toggleSource = (source: KeywordVolumeSource) => {
    setSources((current) => current.includes(source) ? current.filter((item) => item !== source) : [...current, source]);
    setResult(null);
  };

  const importSurfer = async (file?: File) => {
    if (!file || !importCountry) return;
    setImportMessage("");
    try {
      const parsed = parseKeywordSurferCsv(await file.text(), importCountry);
      setSurferRows((current) => [...current.filter((row) => row.country !== importCountry), ...parsed]);
      setImportMessage(`${importCountry}: импортировано ${parsed.length} строк`);
      setResult(null);
    } catch (importError) {
      setImportMessage(importError instanceof Error ? importError.message : "Не удалось прочитать CSV.");
    }
  };

  const run = async () => {
    if (!keywords.length || !countries.length || !sources.length) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      setResult(await collectKeywordVolumes({
        keywords,
        countries,
        sources,
        ...(sources.includes("keyword_surfer") ? { surferRows } : {}),
      }));
    } catch (requestError) {
      setError(requestError instanceof ApiRequestError ? requestError.message : requestError instanceof Error ? requestError.message : "Не удалось собрать объём ключевых слов.");
    } finally {
      setLoading(false);
    }
  };

  const exportCsv = () => {
    if (!result) return;
    const header = ["Country", "Keyword", ...sources.map((source) => sourceInfo[source].label)];
    const lines = [header, ...result.rows.map((row) => [row.country, row.keyword, ...sources.map((source) => row.metrics[source]?.volume ?? "")])];
    const csv = lines.map((line) => line.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    link.download = `keyword-volume-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const grouped = useMemo(() => result ? countries.map((country) => ({ country, rows: result.rows.filter((row) => row.country === country) })) : [], [countries, result]);

  return <div className="keyword-volume-panel">
    <section className="keyword-volume-builder">
      <header><span><BarChart3 size={23} /></span><div><h2>Сравнение объёма ключевых слов</h2><p>До 30 ключей и 20 стран за один проект. Источники запускаются независимо и сводятся в одну таблицу.</p></div></header>
      <div className="keyword-builder-grid">
        <section className="keyword-entry-block">
          <label><span>1. Ключевые слова <b>{keywords.length}/30</b></span><div><textarea value={draft} disabled={keywords.length >= 30} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); addKeywords(); } }} placeholder="Введите ключ и нажмите Enter. Можно вставить список через запятую или с новой строки." /><button type="button" disabled={!draft.trim() || keywords.length >= 30} onClick={addKeywords} aria-label="Добавить ключевые слова"><Plus size={19} /></button></div></label>
          <div className="keyword-tags">{keywords.map((keyword) => <span key={keyword}>{keyword}<button type="button" onClick={() => { setKeywords((current) => current.filter((item) => item !== keyword)); setResult(null); }}><X size={13} /></button></span>)}{!keywords.length && <small>Добавленные ключи появятся здесь</small>}</div>
        </section>
        <section className="keyword-location-block"><span>2. Страны поиска <b>{countries.length}/20</b></span><CountryPicker value={countries} onChange={(value) => { setCountries(value); setResult(null); }} /><p>Для каждой страны будет отдельный блок строк в отчёте.</p></section>
      </div>

      <section className="keyword-source-block"><header><span>3. Источники данных</span><button type="button" onClick={onOpenSettings}><Settings2 size={15} />Настроить API</button></header><div>{(Object.keys(sourceInfo) as KeywordVolumeSource[]).map((source) => {
        const InfoIcon = sourceInfo[source].icon;
        const configured = source === "google_ads" ? googleConfigured : surferExtension.configured || surferRows.length > 0;
        return <button type="button" key={source} className={sources.includes(source) ? "selected" : ""} onClick={() => toggleSource(source)}><i>{sources.includes(source) && <Check size={14} />}</i><span><b><InfoIcon size={17} />{sourceInfo[source].label}</b><small>{sourceInfo[source].caption}</small></span><em className={configured ? "ready" : "missing"}>{configured ? source === "keyword_surfer" ? surferRows.length ? `CSV · ${new Set(surferRows.map((row) => row.country)).size} стран` : `v${surferExtension.version ?? "?"}` : "настроен" : source === "keyword_surfer" ? "нужен ZIP" : "нужен ключ"}</em></button>;
      })}</div></section>

      {sources.includes("keyword_surfer") && <section className="surfer-import-block"><div><span><Upload size={18} /></span><div><strong>{surferExtension.configured ? `Автосбор Keyword Surfer ${surferExtension.version ?? ""} подключён` : "Keyword Surfer пока не загружен"}</strong><p>{surferExtension.configured ? "Сервер сам получит выбранные ключи по странам из источника установленного расширения. CSV ниже остаётся резервным режимом и, если импортирован, имеет приоритет." : "Загрузите ZIP расширения через «Настроить API». Пока можно использовать ручной импорт CSV."}</p></div></div><div className="surfer-import-controls"><select value={importCountry} onChange={(event) => setImportCountry(event.target.value)}><option value="">Страна для CSV</option>{countries.map((country) => <option key={country} value={country}>{META_COUNTRIES.find((option) => option.value === country)?.label ?? country} · {country}</option>)}</select><label className={!importCountry ? "disabled" : ""}><Upload size={15} />Резервный CSV<input type="file" accept=".csv,text/csv" disabled={!importCountry} onChange={(event) => { void importSurfer(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label></div>{importMessage && <p className="surfer-import-message">{importMessage}</p>}{surferRows.length > 0 && <div className="surfer-imported-countries">{[...new Set(surferRows.map((row) => row.country))].map((country) => <span key={country}><CheckCircle2 size={13} />{country} · {surferRows.filter((row) => row.country === country).length}<button type="button" onClick={() => setSurferRows((current) => current.filter((row) => row.country !== country))}><X size={12} /></button></span>)}</div>}</section>}

      <footer><span><KeyRound size={15} />Секреты API не сохраняются на сервере</span><button className="button primary" disabled={!keywords.length || !countries.length || !sources.length || loading} onClick={() => void run()}>{loading ? <LoaderCircle className="spin" size={17} /> : <BarChart3 size={17} />}{loading ? "Собираем данные…" : "Получить объём"}</button></footer>
    </section>

    {error && <div className="keyword-volume-request-error"><AlertTriangle size={20} /><div><strong>Сбор не завершён</strong><p>{error}</p></div></div>}

    {result && <section className="keyword-volume-results">
      <header><div><span><Table2 size={20} /></span><div><h2>Результаты сравнения</h2><p>{result.rows.length} комбинаций «ключ × страна» · {new Date(result.createdAt).toLocaleString("ru-RU")}</p></div></div><button className="button ghost" onClick={exportCsv}><FileDown size={16} />Скачать CSV</button></header>
      <div className="keyword-source-statuses">{result.sources.map((source) => <article key={source.source} className={source.status}><i>{source.status === "completed" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}</i><span><strong>{sourceInfo[source.source].label}</strong><small>{source.message}</small></span></article>)}</div>
      <div className="keyword-source-diagnostics-list">{result.sources.map((source) => <SourceDiagnostics key={source.source} source={source} />)}</div>
      {grouped.map((group) => <section className="keyword-country-result" key={group.country}><header><Globe2 size={17} /><strong>{group.rows[0]?.countryName ?? group.country}</strong><span>{group.country}</span></header><div className="keyword-table-scroll"><table><thead><tr><th>Ключевое слово</th>{sources.map((source) => <th key={source}>{sourceInfo[source].label}</th>)}</tr></thead><tbody>{group.rows.map((row) => <tr key={`${row.country}-${row.keyword}`}><td>{row.keyword}</td>{sources.map((source) => <td key={source}>{metricCell(row.metrics[source])}</td>)}</tr>)}</tbody></table></div></section>)}
    </section>}
  </div>;
}
