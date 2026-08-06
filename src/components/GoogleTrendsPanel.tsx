import { AlertTriangle, ArrowUpRight, BarChart3, Check, Clock3, Download, FileDown, Globe2, LineChart, LoaderCircle, Search, Sparkles, Table2, TrendingUp, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ApiRequestError, collectGoogleTrendsReport } from "../api";
import { META_COUNTRIES } from "../shared/filterOptions";
import type { GoogleTrendsLogEntry, GoogleTrendsProgress, GoogleTrendsProperty, GoogleTrendsRelatedItem, GoogleTrendsReport, GoogleTrendsTimeRange } from "../shared/types";

const colors = ["#4f74ec", "#ea4d45", "#f2a600", "#36a268", "#9865df", "#29a7c9", "#e06aa2", "#687284"];
const timeRanges: Array<{ value: GoogleTrendsTimeRange; label: string }> = [
  { value: "now 7-d", label: "Последние 7 дней" },
  { value: "today 1-m", label: "Последние 30 дней" },
  { value: "today 3-m", label: "Последние 90 дней" },
  { value: "today 12-m", label: "Последние 12 месяцев" },
  { value: "today 5-y", label: "Последние 5 лет" },
  { value: "all", label: "С 2004 года" },
];
const properties: Array<{ value: GoogleTrendsProperty; label: string }> = [
  { value: "", label: "Веб-поиск" },
  { value: "images", label: "Картинки" },
  { value: "news", label: "Новости" },
  { value: "youtube", label: "YouTube" },
  { value: "froogle", label: "Google Покупки" },
];

function uniqueKeywords(values: string[]): string[] {
  const seen = new Set<string>();
  return values.flatMap((raw) => raw.split(/[\n,]/)).map((value) => value.trim()).filter((value) => {
    const key = value.toLocaleLowerCase("ru");
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(report: GoogleTrendsReport): void {
  const rows: unknown[][] = [
    ["section", "seed_keyword", "country", "date_or_query", "value", "formatted_value", "search_type"],
    ["report", "", report.countryName, report.timeRangeLabel, "", "", report.propertyLabel],
    ...report.series.map((item) => ["summary", item.keyword, report.countryName, item.peakLabel, item.average, `current=${item.current}; max=${item.maximum}; change=${item.changePercent ?? "n/a"}%`, report.propertyLabel]),
    ...report.timeline.flatMap((point) => report.request.keywords.map((keyword, index) => ["timeline", keyword, report.countryName, point.label, point.values[index], point.partial ? "partial" : "", report.propertyLabel])),
    ...report.regions.flatMap((region) => report.request.keywords.map((keyword, index) => ["region", keyword, region.name, region.code, region.values[index], "", report.propertyLabel])),
    ...report.related.flatMap((group) => [
      ...group.top.map((item) => ["related_top", group.keyword, report.countryName, item.query, item.value, item.formattedValue, report.propertyLabel]),
      ...group.rising.map((item) => ["related_rising", group.keyword, report.countryName, item.query, item.value, item.formattedValue, report.propertyLabel]),
    ]),
  ];
  const blob = new Blob(["\uFEFF", rows.map((row) => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `google-trends-${new Date(report.createdAt).toISOString().slice(0, 10)}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function exportPdf(report: GoogleTrendsReport): void {
  const previousTitle = document.title;
  const timeline = document.querySelector<HTMLDetailsElement>("#google-trends-report .trends-timeline-table");
  const timelineWasOpen = timeline?.open ?? false;
  document.title = `Google_Trends_${report.request.keywords.join("_").slice(0, 80)}_${report.createdAt.slice(0, 10)}`;
  document.documentElement.classList.add("printing-trends");
  if (timeline) timeline.open = true;
  window.print();
  window.setTimeout(() => {
    if (timeline) timeline.open = timelineWasOpen;
    document.documentElement.classList.remove("printing-trends");
    document.title = previousTitle;
  }, 500);
}

function trendValue(item: GoogleTrendsRelatedItem): string {
  if (item.formattedValue) return item.formattedValue;
  return item.value === undefined ? "—" : String(item.value);
}

function TrendsChart({ report }: { report: GoogleTrendsReport }) {
  const width = 1180;
  const height = 370;
  const padding = { top: 24, right: 22, bottom: 44, left: 45 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const denominator = Math.max(1, report.timeline.length - 1);
  const paths = report.request.keywords.map((keyword, seriesIndex) => ({
    keyword,
    color: colors[seriesIndex],
    points: report.timeline.map((point, pointIndex) => `${padding.left + (pointIndex / denominator) * plotWidth},${padding.top + plotHeight - ((point.values[seriesIndex] ?? 0) / 100) * plotHeight}`).join(" "),
  }));
  const labelIndexes = [...new Set([0, Math.floor(denominator / 4), Math.floor(denominator / 2), Math.floor((denominator * 3) / 4), denominator])];
  return <section className="trends-chart-card">
    <header><div><LineChart size={21} /><span><h3>Динамика популярности</h3><p>Единая относительная шкала Google Trends: 100 — пик интереса внутри выбранного сравнения.</p></span></div><div className="trends-chart-legend">{paths.map((path) => <span key={path.keyword}><i style={{ background: path.color }} />{path.keyword}</span>)}</div></header>
    <div className="trends-chart-scroll"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="График динамики популярности Google Trends">
      {[0, 25, 50, 75, 100].map((tick) => {
        const y = padding.top + plotHeight - (tick / 100) * plotHeight;
        return <g key={tick}><line x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="trends-grid-line" /><text x={padding.left - 10} y={y + 4} textAnchor="end" className="trends-axis-label">{tick}</text></g>;
      })}
      {paths.map((path) => <polyline key={path.keyword} points={path.points} fill="none" stroke={path.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><title>{path.keyword}</title></polyline>)}
      {labelIndexes.map((pointIndex) => {
        const point = report.timeline[pointIndex];
        if (!point) return null;
        const x = padding.left + (pointIndex / denominator) * plotWidth;
        return <text key={`${point.timestamp}-${pointIndex}`} x={x} y={height - 14} textAnchor={pointIndex === 0 ? "start" : pointIndex === denominator ? "end" : "middle"} className="trends-axis-label">{point.label}</text>;
      })}
    </svg></div>
  </section>;
}

function TrendsLog({ logs }: { logs: GoogleTrendsLogEntry[] }) {
  if (!logs.length) return null;
  return <details className="trends-log"><summary><span>Лог Chromium и Google Trends</span><small>{logs.length} событий</small></summary><ol>{logs.map((entry, index) => <li key={`${entry.at}-${entry.stage}-${index}`} className={entry.status}><time>+{(entry.elapsedMs / 1000).toFixed(1)} с</time><div><strong>{entry.stage}</strong><p>{entry.message}</p>{entry.details && <dl>{Object.entries(entry.details).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>}</div></li>)}</ol></details>;
}

export function GoogleTrendsPanel() {
  const [keywords, setKeywords] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [country, setCountry] = useState("UA");
  const [timeRange, setTimeRange] = useState<GoogleTrendsTimeRange>("today 5-y");
  const [property, setProperty] = useState<GoogleTrendsProperty>("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<GoogleTrendsProgress | null>(null);
  const [result, setResult] = useState<GoogleTrendsReport | null>(null);
  const [error, setError] = useState("");
  const [errorDetails, setErrorDetails] = useState<Record<string, unknown> | undefined>();
  const countries = useMemo(() => META_COUNTRIES, []);

  const addKeywords = () => {
    const next = uniqueKeywords([...keywords, draft]).slice(0, 8);
    setKeywords(next);
    setDraft("");
    setError("");
  };

  const submit = async () => {
    const pending = uniqueKeywords([...keywords, draft]).slice(0, 8);
    if (!pending.length) { setError("Добавьте хотя бы одно ключевое слово."); return; }
    setKeywords(pending);
    setDraft("");
    setLoading(true);
    setError("");
    setErrorDetails(undefined);
    setResult(null);
    setProgress({ stage: "queued", activity: "Запускаем сборщик Google Trends…", completedSteps: 0, totalSteps: pending.length + 3, logs: [] });
    try {
      setResult(await collectGoogleTrendsReport({ keywords: pending, country, timeRange, property }, setProgress));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось собрать Google Trends.");
      if (requestError instanceof ApiRequestError) setErrorDetails({ code: requestError.code, status: requestError.status, action: requestError.action ?? "", traceId: requestError.traceId ?? "", ...requestError.details });
    } finally {
      setLoading(false);
    }
  };

  const progressPercent = progress ? Math.min(100, Math.round((progress.completedSteps / Math.max(1, progress.totalSteps)) * 100)) : 0;

  return <div className="google-trends-panel">
    <section className="trends-builder">
      <header><span><TrendingUp size={23} /></span><div><h2>Отчёт Google Trends</h2><p>Сравните до восьми запросов, получите динамику интереса, географию и связанные запросы отдельно для каждого ключа.</p></div></header>
      <div className="trends-builder-grid">
        <section className="trends-keyword-entry"><label><span>Ключевые слова <b>{keywords.length}/8</b></span><div><Search size={17} /><input value={draft} maxLength={120} disabled={loading || keywords.length >= 8} placeholder="Введите ключ и нажмите Enter" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addKeywords(); } }} /><button type="button" aria-label="Добавить ключ" disabled={loading || !draft.trim() || keywords.length >= 8} onClick={addKeywords}><Check size={17} /></button></div></label><div className="trends-keyword-tags">{keywords.map((keyword, index) => <span key={keyword} style={{ "--trend-color": colors[index] } as React.CSSProperties}><i />{keyword}<button type="button" disabled={loading} aria-label={`Удалить ${keyword}`} onClick={() => setKeywords((items) => items.filter((item) => item !== keyword))}><X size={13} /></button></span>)}{!keywords.length && <small>Например: ai girlfriend, virtual companion, ai dating</small>}</div></section>
        <section className="trends-filter-grid">
          <label><span>Страна</span><div><Globe2 size={16} /><select value={country} disabled={loading} onChange={(event) => setCountry(event.target.value)}>{countries.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div></label>
          <label><span>Период</span><div><Clock3 size={16} /><select value={timeRange} disabled={loading} onChange={(event) => setTimeRange(event.target.value as GoogleTrendsTimeRange)}>{timeRanges.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div></label>
          <label><span>Тип поиска</span><div><Sparkles size={16} /><select value={property} disabled={loading} onChange={(event) => setProperty(event.target.value as GoogleTrendsProperty)}>{properties.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div></label>
        </section>
      </div>
      <footer><span><BarChart3 size={15} />Google Trends — относительный индекс 0–100, не абсолютный объём запросов.</span><button className="button primary" disabled={loading || (!keywords.length && !draft.trim())} onClick={() => void submit()}>{loading ? <LoaderCircle className="spin" size={17} /> : <TrendingUp size={17} />}{loading ? "Собираем отчёт…" : "Собрать отчёт"}</button></footer>
    </section>

    {loading && progress && <section className="trends-progress"><div className="trends-progress-icon"><LoaderCircle className="spin" size={25} /></div><div><header><strong>{progress.activity}</strong><span>{progressPercent}%</span></header><div className="trends-progress-bar"><i style={{ width: `${progressPercent}%` }} /></div><small>Связанные запросы собираются отдельно для каждого исходного ключа.</small></div></section>}

    {error && <section className="trends-error"><AlertTriangle size={21} /><div><strong>Не удалось собрать отчёт</strong><p>{error}</p>{errorDetails && <details><summary>Технические детали</summary><pre>{JSON.stringify(errorDetails, null, 2)}</pre></details>}</div><button className="button ghost" onClick={() => void submit()}>Повторить</button></section>}
    {!result && progress?.logs.length ? <TrendsLog logs={progress.logs} /> : null}

    {result && <section className="trends-report" id="google-trends-report">
      <header className="trends-report-toolbar"><div><span><TrendingUp size={20} /></span><div><h2>Google Trends · {result.countryName}</h2><p>{result.timeRangeLabel} · {result.propertyLabel} · {new Date(result.createdAt).toLocaleString("ru-RU")}</p></div></div><div><a className="button ghost" href={result.sourceUrl} target="_blank" rel="noreferrer">Открыть в Trends <ArrowUpRight size={15} /></a><button className="button ghost" onClick={() => downloadCsv(result)}><Download size={15} />Скачать CSV</button><button className="button primary" onClick={() => exportPdf(result)}><FileDown size={15} />Выгрузить PDF</button></div></header>
      <div className="trends-summary-grid">{result.series.map((series, index) => <article key={series.keyword} style={{ "--trend-color": colors[index] } as React.CSSProperties}><header><i /><span>{series.keyword}</span></header><strong>{series.average}</strong><small>средний интерес</small><dl><div><dt>Сейчас</dt><dd>{series.current}</dd></div><div><dt>Пик</dt><dd>{series.maximum}</dd></div><div><dt>Динамика</dt><dd className={(series.changePercent ?? 0) >= 0 ? "up" : "down"}>{series.changePercent === undefined ? "—" : `${series.changePercent > 0 ? "+" : ""}${series.changePercent}%`}</dd></div></dl>{series.peakLabel && <p>Пиковый период: {series.peakLabel}</p>}</article>)}</div>
      <TrendsChart report={result} />

      {result.regions.length > 0 && <section className="trends-table-card"><header><div><Globe2 size={20} /><span><h3>Интерес по регионам</h3><p>Все географические строки, которые вернул Google Trends.</p></span></div><b>{result.regions.length}</b></header><div className="trends-table-scroll"><table><thead><tr><th>Регион</th>{result.request.keywords.map((keyword, index) => <th key={keyword}><i style={{ background: colors[index] }} />{keyword}</th>)}</tr></thead><tbody>{result.regions.map((region) => <tr key={region.code}><td><strong>{region.name}</strong><small>{region.code}</small></td>{region.values.map((value, index) => <td key={`${region.code}-${index}`}>{value}</td>)}</tr>)}</tbody></table></div></section>}

      <section className="trends-related"><header><div><Sparkles size={21} /><span><h3>Связанные поисковые запросы</h3><p>Обе выдачи собраны отдельно после переключения на каждый исходный ключ.</p></span></div><b>{result.related.reduce((total, item) => total + item.top.length + item.rising.length, 0)} запросов</b></header><div className="trends-related-groups">{result.related.map((group, keywordIndex) => <article key={group.keyword} style={{ "--trend-color": colors[keywordIndex] } as React.CSSProperties}><header><i /><div><small>Исходный ключ</small><h4>{group.keyword}</h4></div><span>{group.top.length + group.rising.length}</span></header><div className="trends-related-columns"><section><h5>Популярные запросы</h5>{group.top.length ? <ol>{group.top.map((item, index) => <li key={`${item.query}-${index}`}><span>{index + 1}</span><strong>{item.query}</strong><b>{trendValue(item)}</b></li>)}</ol> : <p>Google не вернул популярных запросов.</p>}</section><section className="rising"><h5>Набирающие популярность</h5>{group.rising.length ? <ol>{group.rising.map((item, index) => <li key={`${item.query}-${index}`}><span>{index + 1}</span><strong>{item.query}</strong><b>{trendValue(item)}</b></li>)}</ol> : <p>Google не вернул растущих запросов.</p>}</section></div></article>)}</div></section>

      <details className="trends-timeline-table"><summary><Table2 size={17} /><span>Полная таблица динамики</span><small>{result.timeline.length} периодов</small></summary><div className="trends-table-scroll"><table><thead><tr><th>Период</th>{result.request.keywords.map((keyword) => <th key={keyword}>{keyword}</th>)}</tr></thead><tbody>{result.timeline.map((point) => <tr key={point.timestamp}><td>{point.label}{point.partial ? " *" : ""}</td>{point.values.map((value, index) => <td key={`${point.timestamp}-${index}`}>{value}</td>)}</tr>)}</tbody></table></div></details>
      <div className="trends-warnings"><AlertTriangle size={19} /><div><strong>Как читать отчёт</strong>{result.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div></div>
      <TrendsLog logs={result.logs} />
    </section>}
  </div>;
}
