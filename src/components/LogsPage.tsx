import {
  Activity, AlertTriangle, Braces, CheckCircle2, ChevronLeft, ChevronRight,
  Clock3, Database, RefreshCw, Search, Server, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchIntegrationLog, fetchIntegrationLogs } from "../api";
import type { AdSource, IntegrationLogDetail, IntegrationLogStatus, IntegrationLogsResponse, IntegrationLogSummary } from "../shared/types";

const PAGE_SIZE = 20;

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(date);
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)} c` : `${value} мс`;
}

function pretty(value: string | null): string {
  if (!value) return "Нет данных";
  try {
    const parsed = JSON.parse(value) as unknown;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

function operationLabel(operation: string): string {
  const labels: Record<string, string> = {
    ads_archive_query: "Поиск объявлений",
    adlib_query: "Поиск объявлений",
    ad_library_preview_page: "Страница превью",
    preview_media_content: "Загрузка креатива",
    preview_media_thumbnail: "Загрузка обложки",
    preview_media_avatar: "Загрузка аватара",
  };
  return labels[operation] ?? operation.replaceAll("_", " ");
}

function StatusBadge({ status }: { status: IntegrationLogStatus }) {
  return <span className={`log-status ${status}`}>
    {status === "success" ? <CheckCircle2 size={13} /> : status === "error" ? <AlertTriangle size={13} /> : <Clock3 size={13} />}
    {status === "success" ? "Успешно" : status === "error" ? "Ошибка" : "В процессе"}
  </span>;
}

function LogDetails({ log, loading, onClose }: { log: IntegrationLogDetail | null; loading: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"request" | "response" | "parsing">("request");
  useEffect(() => { setTab("request"); }, [log?.id]);

  return <>
    <div className="log-drawer-backdrop" onClick={onClose} />
    <aside className="log-drawer" aria-label="Детали интеграционного лога">
      <div className="log-drawer-head">
        <div>
          <span className="eyebrow"><Braces size={13} /> TRACE DETAILS</span>
          <h2>{log ? operationLabel(log.operation) : "Загрузка лога"}</h2>
          {log && <code>#{log.id} · {log.traceId}</code>}
        </div>
        <button onClick={onClose} aria-label="Закрыть"><X size={19} /></button>
      </div>

      {loading || !log ? <div className="log-detail-loading"><RefreshCw size={24} /><span>Получаем полный лог…</span></div> : <>
        <div className="log-detail-overview">
          <StatusBadge status={log.status} />
          <span className={`provider-pill ${log.provider}`}>{log.provider === "meta" ? "META" : "TIKTOK"}</span>
          <span><Clock3 size={14} />{formatDuration(log.durationMs)}</span>
          <span>{formatDate(log.createdAt)}</span>
        </div>
        {log.errorMessage && <div className="log-error-box"><AlertTriangle size={17} /><pre>{log.errorMessage}</pre></div>}
        <div className="log-tabs">
          <button className={tab === "request" ? "active" : ""} onClick={() => setTab("request")}>Запрос</button>
          <button className={tab === "response" ? "active" : ""} onClick={() => setTab("response")}>Ответ <span>{log.responseStatus ?? "—"}</span></button>
          <button className={tab === "parsing" ? "active" : ""} onClick={() => setTab("parsing")}>Парсинг <span>{log.parseAttemptsCount}</span></button>
        </div>
        <div className="log-code-area">
          {tab === "request" && <>
            <div className="code-caption"><span>URL и метод</span></div>
            <pre><code>{`${log.requestMethod} ${log.requestUrl}`}</code></pre>
            <div className="code-caption"><span>Заголовки</span></div>
            <pre><code>{pretty(log.requestHeaders)}</code></pre>
            <div className="code-caption"><span>Тело / параметры</span></div>
            <pre><code>{pretty(log.requestBody)}</code></pre>
          </>}
          {tab === "response" && <>
            <div className="code-caption"><span>Заголовки ответа</span><b>HTTP {log.responseStatus ?? "—"}</b></div>
            <pre><code>{pretty(log.responseHeaders)}</code></pre>
            <div className="code-caption"><span>Тело ответа</span></div>
            <pre className="response-body"><code>{pretty(log.responseBody)}</code></pre>
          </>}
          {tab === "parsing" && <>
            <div className="code-caption"><span>Попытки преобразования данных</span><b>{log.parseAttemptsCount} этапов</b></div>
            <pre className="response-body"><code>{pretty(log.parseAttempts)}</code></pre>
          </>}
        </div>
      </>}
    </aside>
  </>;
}

export function LogsPage() {
  const [provider, setProvider] = useState<AdSource | "">("");
  const [status, setStatus] = useState<IntegrationLogStatus | "">("");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<IntegrationLogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<IntegrationLogDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await fetchIntegrationLogs({
        provider: provider || undefined,
        status: status || undefined,
        search: appliedSearch || undefined,
        offset,
        limit: PAGE_SIZE,
      }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось получить логи");
    } finally {
      setLoading(false);
    }
  }, [provider, status, appliedSearch, offset]);

  useEffect(() => { void load(); }, [load]);

  const openLog = async (item: IntegrationLogSummary) => {
    setSelectedId(item.id);
    setDetail(null);
    setDetailLoading(true);
    try {
      setDetail(await fetchIntegrationLog(item.id));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось открыть лог");
      setSelectedId(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const successRate = useMemo(() => {
    const completed = (data?.stats.success ?? 0) + (data?.stats.errors ?? 0);
    return completed ? Math.round(((data?.stats.success ?? 0) / completed) * 100) : 0;
  }, [data]);

  return <div className="page-wrap logs-page">
    <section className="page-intro logs-intro">
      <div>
        <span className="eyebrow"><Activity size={13} /> INTEGRATION OBSERVABILITY</span>
        <h1>Логи интеграций</h1>
        <p>Диагностика запросов, ответов и преобразования данных Meta и TikTok в одном месте.</p>
      </div>
      <button className="button ghost refresh-logs" onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? "spin" : ""} />Обновить</button>
    </section>

    <section className="log-kpis">
      <article><span className="kpi-icon violet"><Database size={19} /></span><div><small>Всего записей</small><strong>{data?.total ?? 0}</strong><em>хранятся 7 дней</em></div></article>
      <article><span className="kpi-icon green"><CheckCircle2 size={19} /></span><div><small>Успешность</small><strong>{successRate}%</strong><em>{data?.stats.success ?? 0} успешных</em></div></article>
      <article><span className="kpi-icon red"><AlertTriangle size={19} /></span><div><small>Ошибки</small><strong>{data?.stats.errors ?? 0}</strong><em>{data?.stats.inProgress ?? 0} выполняются</em></div></article>
      <article><span className="kpi-icon cyan"><Clock3 size={19} /></span><div><small>Среднее время</small><strong>{formatDuration(data?.stats.averageDurationMs ?? 0)}</strong><em>по текущей выборке</em></div></article>
    </section>

    <section className="logs-panel">
      <div className="logs-filterbar">
        <div className="logs-search">
          <Search size={16} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { setOffset(0); setAppliedSearch(search.trim()); } }} placeholder="Операция, URL, trace ID или ошибка…" />
          {search && <button onClick={() => { setSearch(""); setAppliedSearch(""); setOffset(0); }}><X size={14} /></button>}
        </div>
        <select value={provider} onChange={(event) => { setProvider(event.target.value as AdSource | ""); setOffset(0); }} aria-label="Провайдер">
          <option value="">Все провайдеры</option><option value="meta">Meta</option><option value="tiktok">TikTok</option>
        </select>
        <select value={status} onChange={(event) => { setStatus(event.target.value as IntegrationLogStatus | ""); setOffset(0); }} aria-label="Статус">
          <option value="">Все статусы</option><option value="success">Успешно</option><option value="error">Ошибка</option><option value="started">В процессе</option>
        </select>
        <button className="button primary small" onClick={() => { setOffset(0); setAppliedSearch(search.trim()); }}>Найти</button>
      </div>

      {!data?.databaseEnabled && !loading && <div className="logs-notice"><Database size={21} /><div><strong>База данных не подключена</strong><span>Укажите DB_HOST, DB_NAME, DB_USER и DB_PASSWORD, затем перезапустите API.</span></div></div>}
      {error && <div className="logs-notice error"><AlertTriangle size={21} /><div><strong>Не удалось загрузить логи</strong><span>{error}</span></div><button onClick={() => void load()}>Повторить</button></div>}

      <div className="logs-table-wrap">
        <table className="logs-table">
          <thead><tr><th>Время</th><th>Источник</th><th>Операция</th><th>Статус</th><th>HTTP</th><th>Парсинг</th><th>Время ответа</th><th /></tr></thead>
          <tbody>
            {loading ? Array.from({ length: 7 }).map((_, index) => <tr className="log-row-skeleton" key={index}><td colSpan={8}><span /></td></tr>) : data?.items.map((item) => <tr key={item.id} onClick={() => void openLog(item)}>
              <td><time>{formatDate(item.createdAt)}</time><small>#{item.id}</small></td>
              <td><span className={`provider-pill ${item.provider}`}>{item.provider === "meta" ? "META" : "TIKTOK"}</span></td>
              <td><strong>{operationLabel(item.operation)}</strong><small className="operation-code">{item.operation}</small>{item.errorMessage && <span className="row-error">{item.errorMessage.split("\n")[0]}</span>}</td>
              <td><StatusBadge status={item.status} /></td>
              <td><span className={`http-code ${(item.responseStatus ?? 0) >= 400 ? "bad" : ""}`}>{item.responseStatus ?? "—"}</span></td>
              <td><span className="parse-count"><Braces size={14} />{item.parseAttemptsCount}</span></td>
              <td><span className="duration"><Clock3 size={13} />{formatDuration(item.durationMs)}</span></td>
              <td><button className="row-open" aria-label="Открыть лог"><ChevronRight size={17} /></button></td>
            </tr>)}
          </tbody>
        </table>
        {!loading && data?.items.length === 0 && <div className="logs-empty"><Server size={25} /><strong>Логов не найдено</strong><span>Измените фильтры или выполните новый запрос к провайдеру.</span></div>}
      </div>

      <div className="logs-pagination">
        <span>Показано {data?.items.length ?? 0} из {data?.total ?? 0}</span>
        <div><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}><ChevronLeft size={16} /></button><strong>{currentPage} / {totalPages}</strong><button disabled={currentPage >= totalPages} onClick={() => setOffset(offset + PAGE_SIZE)}><ChevronRight size={16} /></button></div>
      </div>
    </section>

    {selectedId !== null && <LogDetails log={detail} loading={detailLoading} onClose={() => { setSelectedId(null); setDetail(null); }} />}
  </div>;
}
