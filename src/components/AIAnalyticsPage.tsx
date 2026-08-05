import { AlertTriangle, BarChart3, BrainCircuit, CheckCircle2, ChevronDown, FlaskConical, Folder, Gauge, Image, KeyRound, Lightbulb, LoaderCircle, RefreshCw, Rocket, ShieldAlert, Sparkles, Target, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { analyzeCreativeCollection, ApiRequestError, fetchCollections } from "../api";
import { getOpenAIKey, hasOpenAIKey } from "../openaiSettings";
import type { AIAnalysisResponse, CreativeCollection } from "../shared/types";

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
  const [collections, setCollections] = useState<CreativeCollection[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loadingCollections, setLoadingCollections] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [progressIndex, setProgressIndex] = useState(0);
  const [error, setError] = useState<AIErrorInfo | null>(null);
  const [result, setResult] = useState<AIAnalysisResponse | null>(null);
  const keyConfigured = useMemo(() => hasOpenAIKey(), [settingsRevision]);
  const selected = collections.find((collection) => collection.id === selectedId);

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
      setResult(await analyzeCreativeCollection(selectedId, apiKey));
    } catch (analysisError) {
      setError(toErrorInfo(analysisError, "Не удалось выполнить AI-анализ"));
    } finally {
      setAnalyzing(false);
    }
  };

  return <div className="page-wrap ai-page">
    <section className="page-intro ai-intro"><div><span className="eyebrow"><BrainCircuit size={14} /> AI INTELLIGENCE</span><h1>AI Аналитика</h1><p>Сравнивайте сохранённые креативы, их статистику и CTA-лендинги. AI найдёт устойчивые паттерны, оценит перспективность ниши и соберёт план тестов.</p></div><div className={`ai-key-state ${keyConfigured ? "ready" : "missing"}`}>{keyConfigured ? <CheckCircle2 size={18} /> : <KeyRound size={18} />}<span><small>OpenAI API</small><strong>{keyConfigured ? "Ключ подключён" : "Ключ не добавлен"}</strong></span><button onClick={onOpenSettings}>{keyConfigured ? "Изменить" : "Настроить"}</button></div></section>

    <section className="ai-launch-card">
      <div className="ai-launch-copy"><span><Sparkles size={22} /></span><div><h2>Анализ рекламной ниши</h2><p>Выберите коллекцию. Для каждого объявления будут переданы заголовки, текст, длительность, статус, охват, креатив и полный скриншот лендинга.</p></div></div>
      <div className="ai-launch-controls">
        <label><span>Коллекция для анализа</span><div className="ai-collection-select"><Folder size={17} /><select value={selectedId} disabled={loadingCollections || analyzing} onChange={(event) => setSelectedId(event.target.value)}><option value="">{loadingCollections ? "Загружаем…" : "Выберите коллекцию"}</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name} · {collection.itemCount} креативов</option>)}</select><ChevronDown size={16} /></div></label>
        <button className="button primary ai-analyze-button" disabled={!selected || selected.itemCount === 0 || analyzing} onClick={() => void analyze()}>{analyzing ? <><LoaderCircle className="spin" size={18} />Анализируем…</> : <><BrainCircuit size={18} />Проанализировать нишу</>}</button>
      </div>
      {selected && <div className="ai-selection-summary"><span><Image size={16} /><strong>{selected.itemCount}</strong> креативов в коллекции</span><span><Gauge size={16} />За один запуск анализируется до 8 креативов</span><span><ShieldAlert size={16} />Результат — оценка сигналов, не гарантия прибыли</span></div>}
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

    {result && !analyzing && <section className="ai-report">
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

      {(result.warnings.length > 0 || result.analysis.caveats.length > 0) && <div className="ai-caveats"><AlertTriangle size={20} /><div><strong>Ограничения анализа</strong><ul>{[...result.warnings, ...result.analysis.caveats].map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></div></div>}
    </section>}
  </div>;
}
