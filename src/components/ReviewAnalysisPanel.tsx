import { AlertTriangle, Building2, CalendarDays, Check, ExternalLink, FileDown, LoaderCircle, MessageSquareQuote, Search, ShieldCheck, Star, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import { ApiRequestError, searchCompanyReviews } from "../api";
import type { ReviewSearchResponse, ReviewSource, ReviewSourceProgress, ReviewSourceResult, UserReview } from "../shared/types";

const sourceOptions: Array<{ id: ReviewSource; label: string; hint: string }> = [
  { id: "trustpilot", label: "Trustpilot", hint: "Отзывы покупателей и пользователей" },
  { id: "capterra", label: "Capterra", hint: "Отзывы о программах с оценками, плюсами и минусами" },
  { id: "softwareadvice", label: "Software Advice", hint: "Отзывы пользователей, рейтинги, плюсы и минусы" },
];

function sourceMark(source: ReviewSource): string {
  return source === "trustpilot" ? "★" : source === "capterra" ? "C" : "SA";
}

function progressCopy(item: ReviewSourceProgress): string {
  if (item.status === "queued") return "В очереди";
  if (item.status === "running") return "Собираем отзывы…";
  if (item.outcome === "found") return `Готово: ${item.reviewsFound ?? 0} отзывов · ${item.pagesCollected ?? 0} страниц`;
  if (item.outcome === "not_found") return "Компания не найдена";
  if (item.outcome === "blocked") return "Источник включил защиту";
  return "Сбор завершён с ошибкой";
}

function formatReviewDate(value?: string): string {
  if (!value) return "Дата не указана";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" });
}

function Rating({ review }: { review: UserReview }) {
  if (review.rating === undefined) return <span className="review-rating unknown">Оценка не указана</span>;
  return <span className="review-rating" aria-label={`${review.rating} из ${review.maxRating}`}>
    <span>{Array.from({ length: review.maxRating }, (_, index) => <Star key={index} size={15} fill={index < Math.round(review.rating ?? 0) ? "currentColor" : "none"} />)}</span>
    <b>{review.rating}/{review.maxRating}</b>
  </span>;
}

function SourceStatus({ result }: { result: ReviewSourceResult }) {
  const copy = result.status === "not_found"
    ? "Компания не найдена ни по одному из проверенных вариантов адреса."
    : result.status === "blocked"
      ? result.message || "Сервис включил проверку браузера и временно не отдал данные."
      : result.message || "Не удалось разобрать страницу источника.";
  return <div className={`review-source-status ${result.status}`}>
    <AlertTriangle size={21} />
    <div><strong>{result.status === "not_found" ? "Компания не найдена" : result.status === "blocked" ? "Источник включил защиту" : "Ошибка источника"}</strong><p>{copy}</p></div>
  </div>;
}

const attemptLabels = {
  loaded: "Страница загружена",
  found: "Отзывы извлечены",
  empty: "Карточки не найдены",
  not_found: "Страница не найдена",
  blocked: "Проверка браузера",
  error: "Ошибка",
} as const;

function SourceResult({ result }: { result: ReviewSourceResult }) {
  const collectedPages = result.reviews.reduce((maximum, review) => Math.max(maximum, review.page), 0);
  return <section className="review-source-result">
    <header>
      <div><span className={`review-source-logo ${result.source}`}>{sourceMark(result.source)}</span><div><h2>{result.label}</h2><p>{result.companyName || result.query}</p></div></div>
      <div className="review-source-count"><strong>{result.reviews.length}</strong><span>{collectedPages ? `страниц собрано: ${collectedPages}` : "до 6 страниц"}</span></div>
      {result.profileUrl && <a href={result.profileUrl} target="_blank" rel="noreferrer">Открыть профиль <ExternalLink size={14} /></a>}
    </header>
    {result.status === "found"
      ? <div className="review-list">{result.reviews.map((review) => <article className="review-card" key={review.id}>
        <header><div className="review-avatar"><UserRound size={19} /></div><div><strong>{review.author}</strong><span><CalendarDays size={13} />{formatReviewDate(review.date)} · страница {review.page}</span></div><Rating review={review} /></header>
        {review.title && <h3>{review.title}</h3>}
        <p>{review.text || "Текст отзыва отсутствует."}</p>
        {review.reviewUrl && <a href={review.reviewUrl} target="_blank" rel="noreferrer">Оригинал отзыва <ExternalLink size={13} /></a>}
      </article>)}</div>
      : <SourceStatus result={result} />}
    <details className="review-attempts" open={result.status === "blocked" || result.status === "error"}>
      <summary>Лог Chromium ({result.attempts.length} попыток)</summary>
      {result.browser && <div className="review-browser-info"><span><b>Chromium:</b> {result.browser.version}</span><span><b>User-Agent:</b> {result.browser.userAgent}</span><span><b>Прокси:</b> {result.browser.proxy || "не используется"}</span></div>}
      {result.attempts.length
        ? <div className="review-attempt-log">{result.attempts.map((attempt, index) => <article key={`${attempt.url}-${index}`} className={attempt.outcome}>
          <header><b>{index + 1}. {attemptLabels[attempt.outcome]}</b><span>{attempt.durationMs} мс</span></header>
          <dl>
            <div><dt>Запрос</dt><dd>{attempt.url}</dd></div>
            {attempt.finalUrl && <div><dt>Итоговый URL</dt><dd>{attempt.finalUrl}</dd></div>}
            <div><dt>HTTP</dt><dd>{attempt.httpStatus ?? "нет ответа"}</dd></div>
            {attempt.title && <div><dt>Title</dt><dd>{attempt.title}</dd></div>}
            {attempt.reviewsFound !== undefined && <div><dt>Отзывы</dt><dd>{attempt.reviewsFound}</dd></div>}
            {attempt.message && <div><dt>Причина</dt><dd>{attempt.message}</dd></div>}
          </dl>
          {attempt.pagePreview && <details><summary>Фрагмент текста страницы</summary><pre>{attempt.pagePreview}</pre></details>}
        </article>)}</div>
        : <p className="review-log-empty">Chromium не успел открыть страницу. Проверьте серверный журнал.</p>}
    </details>
  </section>;
}

export function ReviewAnalysisPanel() {
  const [query, setQuery] = useState("");
  const [selectedSources, setSelectedSources] = useState<Set<ReviewSource>>(new Set(["trustpilot", "capterra", "softwareadvice"]));
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ReviewSourceProgress[]>([]);
  const [result, setResult] = useState<ReviewSearchResponse | null>(null);
  const [error, setError] = useState<string>("");
  const canSearch = query.trim().length >= 2 && selectedSources.size > 0 && !loading;
  const foundSources = useMemo(() => result?.sources.filter((source) => source.status === "found").length ?? 0, [result]);

  const toggleSource = (source: ReviewSource) => {
    setSelectedSources((current) => {
      const next = new Set(current);
      if (next.has(source)) next.delete(source); else next.add(source);
      return next;
    });
  };

  const submit = async () => {
    if (!canSearch) return;
    setLoading(true);
    setError("");
    setResult(null);
    const sources = [...selectedSources];
    setProgress(sources.map((source) => ({
      source,
      label: sourceOptions.find((option) => option.id === source)?.label ?? source,
      status: "queued",
    })));
    try {
      setResult(await searchCompanyReviews(query.trim(), sources, setProgress));
    } catch (searchError) {
      setError(searchError instanceof ApiRequestError
        ? `${searchError.message}${searchError.action ? ` ${searchError.action}` : ""}`
        : searchError instanceof Error ? searchError.message : "Не удалось запустить сбор отзывов.");
    } finally {
      setLoading(false);
    }
  };

  const exportPdf = () => {
    if (!result) return;
    const previousTitle = document.title;
    document.title = `Отзывы_${result.query}_${new Date().toISOString().slice(0, 10)}`;
    document.documentElement.classList.add("printing-reviews");
    const cleanup = () => {
      document.documentElement.classList.remove("printing-reviews");
      document.title = previousTitle;
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
    window.setTimeout(cleanup, 1_000);
  };

  return <div className="review-analysis-panel" id="review-analysis-print">
    <section className="review-search-card">
      <header><span><MessageSquareQuote size={22} /></span><div><h2>Анализ отзывов пользователей</h2><p>Chromium проверит варианты названия и домена, затем последовательно соберёт до шести доступных страниц каждого сервиса.</p></div></header>
      <div className="review-source-picker">
        <span>Источники отзывов</span>
        <div>{sourceOptions.map((source) => {
          const checked = selectedSources.has(source.id);
          return <button type="button" key={source.id} className={checked ? "selected" : ""} aria-pressed={checked} onClick={() => toggleSource(source.id)}>
            <i>{checked && <Check size={15} />}</i><span><strong>{source.label}</strong><small>{source.hint}</small></span>
          </button>;
        })}</div>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label><span>Название компании или домен</span><div><Building2 size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Например: appsflyer или appsflyer.com" maxLength={120} /></div></label>
        <button className="button primary" disabled={!canSearch}>{loading ? <LoaderCircle className="spin" size={18} /> : <Search size={18} />}{loading ? "Собираем отзывы…" : "Найти отзывы"}</button>
      </form>
      <footer><ShieldCheck size={15} /><span>Trustpilot проверяет варианты домена, а Capterra и Software Advice находят точный профиль через внутренний поиск. Антибот-защита отображается отдельно от результата «не найдено».</span></footer>
    </section>

    {loading && <section className="review-progress detailed">
      <header><LoaderCircle className="spin" size={28} /><div><strong>Chromium собирает отзывы</strong><p>Источники обрабатываются по очереди. Для каждого собирается до шести страниц без повторов.</p></div></header>
      <div className="review-progress-sites">{progress.map((item) => <article key={item.source} className={`${item.status} ${item.outcome ?? ""}`}>
        <span className={`review-source-logo ${item.source}`}>{sourceMark(item.source)}</span>
        <div><strong>{item.label}</strong><small>{progressCopy(item)}</small></div>
        <i>{item.status === "running" ? <LoaderCircle className="spin" size={18} /> : item.status === "completed" && (item.outcome === "found" || item.outcome === "not_found") ? <Check size={18} /> : item.status === "completed" ? <AlertTriangle size={18} /> : <span />}</i>
      </article>)}</div>
    </section>}
    {error && <div className="review-global-error"><AlertTriangle size={20} /><div><strong>Сбор отзывов не завершён</strong><p>{error}</p></div><button className="button ghost" onClick={() => void submit()}>Повторить</button></div>}

    {result && <>
      <section className="review-result-toolbar"><div><span><strong>{result.totalReviews}</strong> отзывов</span><span><strong>{foundSources}</strong> источников найдено</span><small>Собрано {new Date(result.createdAt).toLocaleString("ru-RU")}</small></div><button className="button primary" disabled={!result.totalReviews} onClick={exportPdf}><FileDown size={16} />Выгрузить отзывы в PDF</button></section>
      <div className="review-results">{result.sources.map((source) => <SourceResult key={source.source} result={source} />)}</div>
    </>}
  </div>;
}
