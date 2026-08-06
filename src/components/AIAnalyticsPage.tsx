import { AlertTriangle, BarChart3, BrainCircuit, CheckCircle2, ChevronDown, ExternalLink, FileDown, FileText, FlaskConical, Folder, Gauge, History, Image, KeyRound, Lightbulb, LoaderCircle, MessageSquareText, RefreshCw, Rocket, Save, ShieldAlert, Sparkles, Target, Trash2, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { analyzeCreativeCollection, ApiRequestError, deleteAIAnalysisReport, fetchAIAnalysisCreatives, fetchAIAnalysisReport, fetchAIAnalysisReports, fetchCollections, saveCreativeAnalysisNotes } from "../api";
import { getOpenAIKey, hasOpenAIKey } from "../openaiSettings";
import type { AIAnalysisReportSummary, AIAnalysisResponse, AICreativeNoteItem, CreativeCollection } from "../shared/types";
import { ReviewAnalysisPanel } from "./ReviewAnalysisPanel";

interface AIAnalyticsPageProps {
  onOpenSettings: () => void;
  settingsRevision: number;
}

interface AIErrorInfo {
  message: string;
  action?: string;
  code?: string;
  status?: number;
  traceId?: string;
  details?: Record<string, unknown>;
}

function toErrorInfo(error: unknown, fallback: string): AIErrorInfo {
  if (error instanceof ApiRequestError) {
    return {
      message: error.message,
      action: error.action,
      code: error.code,
      status: error.status,
      traceId: error.traceId,
      details: error.details,
    };
  }
  return { message: error instanceof Error ? error.message : fallback };
}

function errorLog(error: AIErrorInfo): string {
  return JSON.stringify({
    time: new Date().toISOString(),
    code: error.code,
    httpStatus: error.status || undefined,
    traceId: error.traceId,
    message: error.message,
    action: error.action,
    details: error.details,
  }, null, 2);
}

const progressMessages = [
  "Собираем тексты и статистику объявлений…",
  "Извлекаем первый кадр каждого креатива…",
  "Открываем CTA-лендинги и делаем полные скриншоты…",
  "GPT-5.6 сопоставляет креативы, офферы и лендинги…",
  "Формируем оценку ниши и план рекламных тестов…",
];

function ListBlock({ title, icon, items, tone = "violet" }: { title: string; icon: ReactNode; items: string[]; tone?: string }) {
  return <article className={`ai-insight-card ${tone}`}><header><span>{icon}</span><h3>{title}</h3></header><ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></article>;
}

function confidenceLabel(value: AIAnalysisResponse["analysis"]["confidence"]): string {
  return value === "high" ? "Высокая" : value === "medium" ? "Средняя" : "Низкая";
}

export function AIAnalyticsPage({ onOpenSettings, settingsRevision }: AIAnalyticsPageProps) {
  const [activeSection, setActiveSection] = useState<"campaigns" | "reviews">("campaigns");
  const [collections, setCollections] = useState<CreativeCollection[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loadingCollections, setLoadingCollections] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [progressIndex, setProgressIndex] = useState(0);
  const [error, setError] = useState<AIErrorInfo | null>(null);
  const [result, setResult] = useState<AIAnalysisResponse | null>(null);
  const [reports, setReports] = useState<AIAnalysisReportSummary[]>([]);
  const [loadingReports, setLoadingReports] = useState(true);
  const [activeReportId, setActiveReportId] = useState("");
  const [creativeNotes, setCreativeNotes] = useState<AICreativeNoteItem[]>([]);
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [selectedCreativeIds, setSelectedCreativeIds] = useState<Set<string>>(new Set());
  const [noteDraft, setNoteDraft] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [noteMessage, setNoteMessage] = useState("");
  const [exportingPdf, setExportingPdf] = useState(false);
  const keyConfigured = useMemo(() => hasOpenAIKey(), [settingsRevision]);
  const selected = collections.find((collection) => collection.id === selectedId);
  const noteCreatives = creativeNotes;

  useEffect(() => {
    let cancelled = false;
    setLoadingCollections(true);
    fetchCollections().then((items) => {
      if (cancelled) return;
      setCollections(items);
      setSelectedId((current) => current && items.some((item) => item.id === current) ? current : items.find((item) => item.itemCount > 0)?.id ?? items[0]?.id ?? "");
    }).catch((loadError) => {
      if (!cancelled) setError(toErrorInfo(loadError, "Не удалось загрузить коллекции"));
    }).finally(() => { if (!cancelled) setLoadingCollections(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadingReports(true);
    fetchAIAnalysisReports()
      .then((items) => { if (!cancelled) setReports(items); })
      .catch((loadError) => { if (!cancelled) setError(toErrorInfo(loadError, "Не удалось загрузить сохранённые AI-отчёты")); })
      .finally(() => { if (!cancelled) setLoadingReports(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSelectedCreativeIds(new Set());
    setNoteDraft("");
    setNoteMessage("");
    if (!selectedId) { setCreativeNotes([]); return () => { cancelled = true; }; }
    setLoadingNotes(true);
    fetchAIAnalysisCreatives(selectedId)
      .then((items) => { if (!cancelled) setCreativeNotes(items); })
      .catch((loadError) => { if (!cancelled) setError(toErrorInfo(loadError, "Не удалось загрузить креативы для заметок")); })
      .finally(() => { if (!cancelled) setLoadingNotes(false); });
    return () => { cancelled = true; };
  }, [selectedId]);

  useEffect(() => {
    if (!analyzing) return;
    const timer = window.setInterval(() => setProgressIndex((current) => Math.min(current + 1, progressMessages.length - 1)), 4_500);
    return () => window.clearInterval(timer);
  }, [analyzing]);

  const analyze = async () => {
    if (!selectedId) return;
    const apiKey = getOpenAIKey();
    if (!apiKey) { onOpenSettings(); return; }
    setAnalyzing(true);
    setProgressIndex(0);
    setError(null);
    setResult(null);
    try {
      const analysis = await analyzeCreativeCollection(selectedId, apiKey);
      setResult(analysis);
      setActiveReportId("");
      setReports(await fetchAIAnalysisReports());
    } catch (analysisError) {
      setError(toErrorInfo(analysisError, "Не удалось выполнить AI-анализ"));
    } finally {
      setAnalyzing(false);
    }
  };

  const toggleCreative = (item: AICreativeNoteItem) => {
    const next = new Set(selectedCreativeIds);
    if (next.has(item.ad.id)) next.delete(item.ad.id);
    else next.add(item.ad.id);
    setSelectedCreativeIds(next);
    setNoteMessage("");
    if (next.size === 0) {
      setNoteDraft("");
    } else {
      const selectedNotes = [...next].map((adId) => creativeNotes.find((entry) => entry.ad.id === adId)?.note ?? "");
      setNoteDraft(selectedNotes.every((note) => note === selectedNotes[0]) ? selectedNotes[0] : "");
    }
  };

  const saveNotes = async () => {
    if (!selectedId || !selectedCreativeIds.size) return;
    setSavingNote(true);
    setNoteMessage("");
    setError(null);
    try {
      await saveCreativeAnalysisNotes(selectedId, [...selectedCreativeIds], noteDraft.trim());
      setCreativeNotes((items) => items.map((item) => selectedCreativeIds.has(item.ad.id) ? { ...item, note: noteDraft.trim() } : item));
      setNoteMessage(noteDraft.trim() ? `Заметка сохранена для ${selectedCreativeIds.size} креативов` : `Заметка удалена у ${selectedCreativeIds.size} креативов`);
    } catch (saveError) {
      setError(toErrorInfo(saveError, "Не удалось сохранить заметку"));
    } finally {
      setSavingNote(false);
    }
  };

  const openReport = async (reportId: string) => {
    setError(null);
    try {
      const report = await fetchAIAnalysisReport(reportId);
      setResult(report.result);
      setActiveReportId(report.id);
    } catch (loadError) {
      setError(toErrorInfo(loadError, "Не удалось открыть сохранённый отчёт"));
    }
  };

  const removeReport = async (report: AIAnalysisReportSummary) => {
    if (!window.confirm(`Удалить отчёт «${report.name}»?`)) return;
    setError(null);
    try {
      await deleteAIAnalysisReport(report.id);
      setReports((items) => items.filter((item) => item.id !== report.id));
      if (activeReportId === report.id) { setActiveReportId(""); setResult(null); }
    } catch (deleteError) {
      setError(toErrorInfo(deleteError, "Не удалось удалить отчёт"));
    }
  };

  const exportPdf = async () => {
    setExportingPdf(true);
    const images = [...document.querySelectorAll<HTMLImageElement>("#ai-report-print .ai-landing-shot img")];
    await Promise.race([
      Promise.all(images.map((image) => image.decode().catch(() => undefined))),
      new Promise((resolve) => window.setTimeout(resolve, 10_000)),
    ]);
    const previousTitle = document.title;
    const reportName = reports.find((report) => report.id === activeReportId)?.name
      ?? `${result?.collection.name ?? "AI_Аналитика"}_${new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-")}`;
    document.title = reportName;
    window.print();
    window.setTimeout(() => { document.title = previousTitle; }, 500);
    setExportingPdf(false);
  };

  return <div className="page-wrap ai-page">
    <section className="page-intro ai-intro"><div><span className="eyebrow"><BrainCircuit size={14} /> AI INTELLIGENCE</span><h1>AI Аналитика</h1><p>Исследуйте рекламные кампании и отзывы пользователей в одном рабочем пространстве.</p></div>{activeSection === "campaigns" && <div className={`ai-key-state ${keyConfigured ? "ready" : "missing"}`}>{keyConfigured ? <CheckCircle2 size={18} /> : <KeyRound size={18} />}<span><small>OpenAI API</small><strong>{keyConfigured ? "Ключ подключён" : "Ключ не добавлен"}</strong></span><button onClick={onOpenSettings}>{keyConfigured ? "Изменить" : "Настроить"}</button></div>}</section>

    <nav className="ai-section-tabs" aria-label="Разделы AI Аналитики">
      <button className={activeSection === "campaigns" ? "active" : ""} onClick={() => setActiveSection("campaigns")}><BrainCircuit size={19} /><span><strong>Анализ рекламных кампаний</strong><small>Креативы, лендинги и перспективность ниши</small></span></button>
      <button className={activeSection === "reviews" ? "active" : ""} onClick={() => setActiveSection("reviews")}><MessageSquareText size={19} /><span><strong>Анализ отзывов пользователей</strong><small>Trustpilot, Capterra и Software Advice</small></span></button>
    </nav>

    {activeSection === "campaigns" ? <div className="ai-campaign-section">

    <section className="ai-launch-card">
      <div className="ai-launch-copy"><span><Sparkles size={22} /></span><div><h2>Анализ рекламной ниши</h2><p>Выберите коллекцию. Для каждого объявления будут переданы заголовки, текст, длительность, статус, охват, креатив и полный скриншот лендинга.</p></div></div>
      <div className="ai-launch-controls">
        <label><span>Коллекция для анализа</span><div className="ai-collection-select"><Folder size={17} /><select value={selectedId} disabled={loadingCollections || analyzing} onChange={(event) => setSelectedId(event.target.value)}><option value="">{loadingCollections ? "Загружаем…" : "Выберите коллекцию"}</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name} · {collection.itemCount} креативов</option>)}</select><ChevronDown size={16} /></div></label>
        <button className="button primary ai-analyze-button" disabled={!selected || selected.itemCount === 0 || analyzing} onClick={() => void analyze()}>{analyzing ? <><LoaderCircle className="spin" size={18} />Анализируем…</> : <><BrainCircuit size={18} />Проанализировать нишу</>}</button>
      </div>
      {selected && <div className="ai-selection-summary"><span><Image size={16} /><strong>{selected.itemCount}</strong> креативов в коллекции</span><span><Gauge size={16} />За один запуск анализируется до 10 креативов</span><span><ShieldAlert size={16} />Результат — оценка сигналов, не гарантия прибыли</span></div>}
      {selected && <section className="ai-video-notes">
        <header><span><MessageSquareText size={19} /></span><div><h3>Дополнительное описание креативов</h3><p>Выберите один или несколько креативов и добавьте важный контекст. Для видео AI получит заметку вместе с первым кадром, для изображений — вместе с самим изображением.</p></div></header>
        {loadingNotes
          ? <div className="ai-notes-loading"><LoaderCircle className="spin" size={17} />Загружаем креативы…</div>
          : noteCreatives.length
            ? <><div className="ai-video-grid">{noteCreatives.map((item) => {
              const selectedCreative = selectedCreativeIds.has(item.ad.id);
              return <button type="button" key={item.ad.id} className={`ai-video-item ${selectedCreative ? "selected" : ""}`} onClick={() => toggleCreative(item)}>
                <span className="ai-video-thumb">{item.ad.thumbnailUrl ? <img src={item.ad.thumbnailUrl} alt="" loading="lazy" /> : <Image size={20} />}</span>
                <span className="ai-video-copy"><strong>{item.ad.advertiser}</strong><small>{item.ad.headline || "Креатив без заголовка"}</small>{item.note && <em>{item.note}</em>}</span>
                <span className="ai-video-check">{selectedCreative ? <CheckCircle2 size={18} /> : <i />}</span>
              </button>;
            })}</div>
            <div className="ai-note-editor">
              <label><span>Заметка для выбранных креативов ({selectedCreativeIds.size})</span><textarea maxLength={1000} value={noteDraft} disabled={!selectedCreativeIds.size || savingNote} onChange={(event) => setNoteDraft(event.target.value)} placeholder="Например: девушка танцует и показывает платье крупным планом…" /></label>
              <div><small>{noteDraft.length}/1000 · пустое поле удалит существующую заметку</small>{noteMessage && <b>{noteMessage}</b>}<button className="button ghost" disabled={!selectedCreativeIds.size || savingNote} onClick={() => void saveNotes()}>{savingNote ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}Сохранить заметку</button></div>
            </div></>
            : <p className="ai-no-videos">В выбранной коллекции нет креативов.</p>}
      </section>}
    </section>

    <section className="ai-history">
      <header><div><span><History size={20} /></span><div><h2>Сохранённые отчёты</h2><p>Каждый успешно завершённый анализ автоматически сохраняется в базе данных.</p></div></div><small>{reports.length} записей</small></header>
      {loadingReports
        ? <div className="ai-history-empty"><LoaderCircle className="spin" size={17} />Загружаем историю…</div>
        : reports.length
          ? <div className="ai-history-list">{reports.map((report) => <article key={report.id} className={activeReportId === report.id ? "active" : ""}>
            <button className="ai-history-open" onClick={() => void openReport(report.id)}><FileText size={18} /><span><strong>{report.name}</strong><small>{report.niche} · {report.analyzedCount}/{report.totalCount} креативов · {new Date(report.createdAt).toLocaleString("ru-RU")}</small></span><b>{report.opportunityScore}/100</b></button>
            <button className="ai-history-delete" aria-label="Удалить отчёт" onClick={() => void removeReport(report)}><Trash2 size={16} /></button>
          </article>)}</div>
          : <div className="ai-history-empty"><FileText size={20} />Здесь появится первый успешно завершённый AI-отчёт.</div>}
    </section>

    {!loadingCollections && !collections.length && <div className="ai-empty"><Folder size={28} /><h2>Сначала создайте коллекцию</h2><p>Сохраните несколько креативов одной ниши в отдельную коллекцию — после этого здесь появится выбор для анализа.</p></div>}

    {analyzing && <section className="ai-processing"><div className="ai-orbit"><BrainCircuit size={34} /><i /><i /><i /></div><h2>Исследуем коллекцию «{selected?.name}»</h2><p>{progressMessages[progressIndex]}</p><div className="ai-progress-steps">{progressMessages.map((message, index) => <span key={message} className={index <= progressIndex ? "active" : ""}>{index < progressIndex ? <CheckCircle2 size={15} /> : <i />}{message}</span>)}</div><small>Полные лендинги загружаются через Chromium, поэтому первый анализ может занять несколько минут.</small></section>}

    {error && !analyzing && <div className="ai-error">
      <AlertTriangle size={22} />
      <div className="ai-error-content">
        <strong>AI-анализ не завершён</strong>
        <p>{error.message}</p>
        {error.action && <p className="ai-error-action">Что делать: {error.action}</p>}
        {(error.code || error.status || error.traceId || error.details) && <details className="ai-error-log">
          <summary>Показать лог запроса</summary>
          <pre>{errorLog(error)}</pre>
        </details>}
      </div>
      {/ключ|OpenAI/i.test(error.message) && error.code === "OPENAI_KEY_INVALID" ? <button className="button ghost" onClick={onOpenSettings}>Открыть настройки</button> : <button className="button ghost" onClick={() => void analyze()}><RefreshCw size={15} />Повторить</button>}
    </div>}

    {result && !analyzing && <section className="ai-report" id="ai-report-print">
      <div className="ai-report-toolbar"><div><FileText size={17} /><span><strong>{reports.find((report) => report.id === activeReportId)?.name ?? "Текущий AI-отчёт"}</strong><small>PDF включает выводы, таблицы, разбор креативов и сохранённые скриншоты лендингов.</small></span></div><button className="button primary" disabled={exportingPdf} onClick={() => void exportPdf()}>{exportingPdf ? <LoaderCircle className="spin" size={16} /> : <FileDown size={16} />}{exportingPdf ? "Готовим PDF…" : "Выгрузить в PDF"}</button></div>
      <header className="ai-report-head"><div><span className="eyebrow"><TrendingUp size={13} /> NICHE REPORT</span><h2>{result.analysis.niche}</h2><p>{result.analysis.executiveSummary}</p></div><div className={`ai-score ${result.analysis.opportunityScore >= 70 ? "strong" : result.analysis.opportunityScore >= 45 ? "medium" : "weak"}`}><span><strong>{result.analysis.opportunityScore}</strong><small>/100</small></span><em>Потенциал ниши</em></div></header>
      <div className="ai-report-meta"><span><BrainCircuit size={15} />{result.model}</span><span><Image size={15} />Проанализировано {result.analyzedCount} из {result.totalCount}</span><span><Gauge size={15} />Уверенность: {confidenceLabel(result.analysis.confidence)}</span></div>

      <div className="ai-insights-grid">
        <ListBlock title="Сигналы спроса" icon={<TrendingUp size={18} />} items={result.analysis.demandSignals} tone="green" />
        <ListBlock title="Победные паттерны" icon={<Target size={18} />} items={result.analysis.winningPatterns} />
        <ListBlock title="Аудитория" icon={<BarChart3 size={18} />} items={result.analysis.audienceInsights} tone="blue" />
        <ListBlock title="Лендинги" icon={<Rocket size={18} />} items={result.analysis.landingInsights} tone="cyan" />
        <ListBlock title="Риски" icon={<ShieldAlert size={18} />} items={result.analysis.risks} tone="red" />
        <ListBlock title="Что делать" icon={<Lightbulb size={18} />} items={result.analysis.recommendations} tone="amber" />
      </div>

      <section className="ai-test-plan"><header><span><FlaskConical size={20} /></span><div><h3>План рекламных тестов</h3><p>Гипотезы в порядке приоритета</p></div></header><div>{result.analysis.testPlan.map((test, index) => <article key={`${test.hypothesis}-${index}`}><b className={test.priority}>{test.priority === "high" ? "Высокий" : test.priority === "medium" ? "Средний" : "Низкий"}</b><span>{String(index + 1).padStart(2, "0")}</span><div><h4>{test.hypothesis}</h4><p><strong>Креатив:</strong> {test.creativeAngle}</p><p><strong>Оффер:</strong> {test.offer}</p></div></article>)}</div></section>

      <section className="ai-creative-findings"><header><h3>Разбор креативов</h3><span>{result.analysis.creativeFindings.length} объявлений</span></header><div>{result.analysis.creativeFindings.map((finding) => <article key={finding.adId}><div><span>{finding.advertiser.slice(0, 1).toUpperCase()}</span><div><h4>{finding.advertiser}</h4><small>{finding.adId}</small></div></div><p>{finding.verdict}</p><section><div><strong>Что подтверждают данные</strong><ul>{finding.evidence.map((item) => <li key={item}>{item}</li>)}</ul></div><div><strong>Как усилить</strong><ul>{finding.improvements.map((item) => <li key={item}>{item}</li>)}</ul></div></section></article>)}</div></section>

      {Boolean(result.landings?.length) && <section className="ai-report-landings"><header><div><span><Rocket size={20} /></span><div><h3>Лендинги из рекламных связок</h3><p>Сохранённые при анализе версии страниц. Нажмите на скриншот, чтобы открыть его целиком.</p></div></div><b>{result.landings?.length} страниц</b></header><div>{result.landings?.map((landing, index) => <article key={`${landing.adId}-${index}`}><header><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{landing.advertiser}</strong><small>{landing.headline || landing.adId}</small></div></header>{landing.screenshotUrl ? <a className="ai-landing-shot" href={landing.screenshotUrl} target="_blank" rel="noreferrer"><img src={landing.screenshotUrl} alt={`Лендинг ${landing.advertiser}`} /><span>Открыть полный скриншот <ExternalLink size={14} /></span></a> : <div className="ai-landing-missing"><Image size={25} /><span>Скриншот страницы получить не удалось</span></div>}<footer><span title={landing.landingUrl}>{new URL(landing.landingUrl).hostname.replace(/^www\./, "")}</span><a href={landing.landingUrl} target="_blank" rel="noreferrer">{landing.cta || "Открыть лендинг"}<ExternalLink size={14} /></a></footer></article>)}</div></section>}

      {(result.warnings.length > 0 || result.analysis.caveats.length > 0) && <div className="ai-caveats"><AlertTriangle size={20} /><div><strong>Ограничения анализа</strong><ul>{[...result.warnings, ...result.analysis.caveats].map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></div></div>}
    </section>}
    </div> : <ReviewAnalysisPanel />}
  </div>;
}
