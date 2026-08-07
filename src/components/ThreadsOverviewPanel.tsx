import { AtSign, CalendarDays, Check, CheckCircle2, Download, ExternalLink, FileDown, Hash, Image as ImageIcon, LoaderCircle, MessageCircle, Search, ShieldAlert, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { ApiRequestError, fetchThreadsConversation, searchThreadsPosts } from "../api";
import type { ThreadsConversationResponse, ThreadsPost, ThreadsSearchMode, ThreadsSearchResponse, ThreadsSearchType } from "../shared/types";

interface PreparedThread extends ThreadsConversationResponse {
  error?: string;
  action?: string;
}

function formatDate(value: string): string {
  if (!value) return "Дата не указана";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function postPreview(post: ThreadsPost) {
  const preview = post.thumbnailUrl || (post.mediaType?.toUpperCase() === "IMAGE" ? post.mediaUrl : undefined);
  return preview ? <img src={preview} alt="Медиа из поста Threads" loading="lazy" /> : <ImageIcon size={24} />;
}

function postAuthor(post: ThreadsPost) {
  return <div className="threads-author">
    <span className="threads-author-placeholder" aria-hidden="true">👤</span>
    <div><strong>@{post.username}{post.isVerified && <CheckCircle2 size={14} aria-label="Подтверждённый аккаунт" />}</strong><time>{formatDate(post.timestamp)}</time></div>
  </div>;
}

export function ThreadsOverviewPanel({ authenticated }: { authenticated: boolean }) {
  const [query, setQuery] = useState("");
  const [searchType, setSearchType] = useState<ThreadsSearchType>("TOP");
  const [searchMode, setSearchMode] = useState<ThreadsSearchMode>("KEYWORD");
  const [limit, setLimit] = useState(25);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [posts, setPosts] = useState<ThreadsPost[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [errorAction, setErrorAction] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState<ThreadsSearchResponse["diagnostics"]>();
  const [accessMode, setAccessMode] = useState<"authenticated" | "public">(authenticated ? "authenticated" : "public");
  const [paginationFilters, setPaginationFilters] = useState<{ searchType: ThreadsSearchType; searchMode: ThreadsSearchMode; since?: string; until?: string }>();
  const [prepared, setPrepared] = useState<PreparedThread[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [preparationProgress, setPreparationProgress] = useState(0);

  useEffect(() => {
    setAccessMode(authenticated ? "authenticated" : "public");
  }, [authenticated]);

  const selectedPosts = useMemo(() => posts.filter((post) => selectedIds.has(post.id)), [posts, selectedIds]);

  const runSearch = async (after?: string) => {
    const cleanQuery = query.trim();
    if (!cleanQuery) return;
    const loadMore = Boolean(after);
    loadMore ? setLoadingMore(true) : setLoading(true);
    setError("");
    setErrorAction("");
    if (!loadMore) {
      setPrepared([]);
      setSelectedIds(new Set());
      setDiagnostics(undefined);
    }
    try {
      const requestedSince = since ? new Date(`${since}T00:00:00.000Z`).toISOString() : undefined;
      const requestedUntil = until ? new Date(`${until}T23:59:59.999Z`).toISOString() : undefined;
      const effectiveFilters = loadMore && paginationFilters
        ? paginationFilters
        : { searchType, searchMode, ...(requestedSince ? { since: requestedSince } : {}), ...(requestedUntil ? { until: requestedUntil } : {}) };
      const result = await searchThreadsPosts({
        query: cleanQuery,
        searchType: effectiveFilters.searchType,
        searchMode: effectiveFilters.searchMode,
        limit,
        ...(effectiveFilters.since ? { since: effectiveFilters.since } : {}),
        ...(effectiveFilters.until ? { until: effectiveFilters.until } : {}),
        ...(after ? { after } : {}),
      });
      setAccessMode(result.accessMode);
      setWarnings(result.warnings);
      setDiagnostics(result.diagnostics);
      setNextCursor(result.nextCursor);
      setPaginationFilters({
        searchType: result.appliedFilters.searchType,
        searchMode: result.appliedFilters.searchMode,
        ...(result.appliedFilters.since ? { since: result.appliedFilters.since } : {}),
        ...(result.appliedFilters.until ? { until: result.appliedFilters.until } : {}),
      });
      setPosts((current) => {
        if (!loadMore) return result.posts;
        const ids = new Set(current.map((post) => post.id));
        return [...current, ...result.posts.filter((post) => !ids.has(post.id))];
      });
    } catch (searchError) {
      const apiError = searchError instanceof ApiRequestError ? searchError : null;
      setError(searchError instanceof Error ? searchError.message : "Не удалось выполнить поиск в Threads.");
      setErrorAction(apiError?.action ?? "");
    } finally {
      loadMore ? setLoadingMore(false) : setLoading(false);
    }
  };

  const togglePost = (postId: string) => {
    setPrepared([]);
    setSelectedIds((current) => {
      const next = new Set(current);
      next.has(postId) ? next.delete(postId) : next.add(postId);
      return next;
    });
  };

  const selectAll = () => {
    setPrepared([]);
    setSelectedIds(new Set(posts.slice(0, 20).map((post) => post.id)));
  };

  const prepareReport = async () => {
    if (!selectedPosts.length) return;
    setPreparing(true);
    setPrepared([]);
    setPreparationProgress(0);
    const items: PreparedThread[] = [];
    for (let index = 0; index < selectedPosts.length; index += 1) {
      const post = selectedPosts[index];
      try {
        items.push(await fetchThreadsConversation(post));
      } catch (conversationError) {
        const apiError = conversationError instanceof ApiRequestError ? conversationError : null;
        items.push({
          post,
          replies: [],
          warnings: [],
          truncated: false,
          error: conversationError instanceof Error ? conversationError.message : "Ответы к посту получить не удалось.",
          action: apiError?.action,
        });
      }
      setPreparationProgress(index + 1);
      setPrepared([...items]);
    }
    setPreparing(false);
  };

  const exportPdf = async () => {
    const images = [...document.querySelectorAll<HTMLImageElement>("#threads-pdf-report img")];
    await Promise.race([
      Promise.all(images.map((image) => image.decode().catch(() => undefined))),
      new Promise((resolve) => window.setTimeout(resolve, 5_000)),
    ]);
    const previousTitle = document.title;
    document.title = `Threads_${query.trim().replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 40)}_${new Date().toISOString().slice(0, 10)}`;
    document.documentElement.classList.add("printing-threads");
    window.print();
    window.setTimeout(() => {
      document.documentElement.classList.remove("printing-threads");
      document.title = previousTitle;
    }, 500);
  };

  return <div className="threads-overview-panel">
    <section className="threads-search-card">
      <header><div><span><AtSign size={24} /></span><div><h2>Поиск сигналов в Threads</h2><p>Найдите публичные посты по тексту, выберите важные и соберите посты вместе с ветками ответов в один PDF.</p></div></div><span className="threads-token-state ready"><i />{accessMode === "authenticated" ? "Авторизованный Chromium" : "Публичный веб-поиск"}</span></header>
      <form onSubmit={(event) => { event.preventDefault(); void runSearch(); }}>
        <label className="threads-query-field"><span>Текст для поиска</span><div>{searchMode === "TAG" ? <Hash size={19} /> : <Search size={19} />}<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={searchMode === "TAG" ? "Например: productmanagement" : "Например: onboarding mobile app"} maxLength={100} disabled={loading} /><button className="button primary" disabled={loading || !query.trim()}>{loading ? <LoaderCircle className="spin" size={18} /> : <Search size={18} />}{loading ? "Ищем…" : "Найти посты"}</button></div></label>
        <div className="threads-filter-grid">
          <label><span>Режим</span><select value={searchMode} onChange={(event) => setSearchMode(event.target.value as ThreadsSearchMode)} disabled={loading}><option value="KEYWORD">Текст и ключевые слова</option><option value="TAG">Тег темы</option></select></label>
          <label><span>Сортировка</span><select value={searchType} onChange={(event) => setSearchType(event.target.value as ThreadsSearchType)} disabled={loading}><option value="TOP">Сначала популярные</option><option value="RECENT">Сначала свежие</option></select></label>
          <label><span>С даты</span><input type="date" value={since} max={until || undefined} onChange={(event) => setSince(event.target.value)} disabled={loading} /></label>
          <label><span>По дату</span><input type="date" value={until} min={since || undefined} onChange={(event) => setUntil(event.target.value)} disabled={loading} /></label>
          <label><span>Результатов</span><select value={limit} onChange={(event) => setLimit(Number(event.target.value))} disabled={loading}><option value={10}>10</option><option value={25}>25</option><option value={50}>50</option></select></label>
        </div>
      </form>
    </section>

    {error && <div className="threads-error"><ShieldAlert size={21} /><div><strong>Threads не выполнил запрос</strong><p>{error}</p>{errorAction && <small>{errorAction}</small>}</div></div>}
    {warnings.map((warning) => <div className="threads-warning" key={warning}><Sparkles size={18} />{warning}</div>)}

    {diagnostics?.feedLoads && diagnostics.feedLoads.length > 0 && <details className="threads-debug-log" open={diagnostics.loadTimedOut}>
      <summary><span><LoaderCircle size={17} />Временный лог подгрузки Threads</span><small>{diagnostics.collected ?? 0} уникальных постов · {diagnostics.loadedPages ?? 1} пачек · {diagnostics.feedLoads.length} попыток</small></summary>
      <div className="threads-debug-body">
        <div className="threads-debug-meta"><span>Итоговый URL</span><code>{diagnostics.url}</code></div>
        <div className="threads-debug-rows">{diagnostics.feedLoads.map((entry) => <article className={entry.outcome} key={`${entry.pass}-${entry.durationMs}`}>
          <header><strong>Прокрутка {entry.pass}</strong><em>{entry.outcome === "loaded" ? "Загружено" : entry.outcome === "timeout" ? "Таймаут" : "Конец ленты"}</em><time>{(entry.durationMs / 1000).toFixed(1)} с</time></header>
          <p>{entry.reason}</p>
          <dl>
            <div><dt>Уникальных добавлено</dt><dd>+{entry.newUniquePosts}</dd></div>
            <div><dt>Всего накоплено</dt><dd>{entry.collectedTotal}</dd></div>
            <div><dt>Постов в DOM</dt><dd>{entry.beforeDomPosts} → {entry.afterDomPosts}</dd></div>
            <div><dt>Высота DOM</dt><dd>{entry.beforeHeight} → {entry.afterHeight}</dd></div>
            <div><dt>Спиннер появился</dt><dd>{entry.sawLoader ? "да" : "нет"}</dd></div>
            <div><dt>Спиннер исчез</dt><dd>{entry.loaderFinished ? "да" : "нет"}</dd></div>
            <div><dt>Последний URL сменился</dt><dd>{entry.lastPostChanged ? "да" : "нет"}</dd></div>
          </dl>
        </article>)}</div>
      </div>
    </details>}

    {posts.length > 0 && <section className="threads-results">
      <header><div><h2>Найденные посты</h2><p>{posts.length} результатов · выбрано {selectedIds.size} из 20 доступных для одного PDF</p></div><div><button type="button" className="button ghost" onClick={selectAll}><Check size={16} />Выбрать первые {Math.min(posts.length, 20)}</button><button type="button" className="button ghost" disabled={!selectedIds.size} onClick={() => { setSelectedIds(new Set()); setPrepared([]); }}><X size={16} />Снять выбор</button></div></header>
      <div className="threads-post-grid">{posts.map((post) => {
        const selected = selectedIds.has(post.id);
        const selectionDisabled = !selected && selectedIds.size >= 20;
        return <article key={post.id} className={selected ? "selected" : ""} onClick={() => { if (!selectionDisabled) togglePost(post.id); }}>
          <button type="button" className="threads-post-check" disabled={selectionDisabled} aria-label={selected ? "Снять выбор" : "Выбрать пост"}>{selected ? <Check size={16} /> : null}</button>
          {postAuthor(post)}
          <p className="threads-post-text">{post.text || "Пост без текстового описания"}</p>
          {(post.mediaUrl || post.thumbnailUrl) && <div className="threads-post-media">{postPreview(post)}</div>}
          <footer><span>{post.topicTag ? `#${post.topicTag}` : post.hasReplies ? "Есть ответы" : "Публичный пост"}</span><a href={post.permalink} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>Оригинал <ExternalLink size={14} /></a></footer>
        </article>;
      })}</div>
      {nextCursor && <button type="button" className="button ghost threads-load-more" disabled={loadingMore} onClick={() => void runSearch(nextCursor)}>{loadingMore ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}{loadingMore ? "Загружаем…" : "Показать ещё"}</button>}
    </section>}

    {selectedPosts.length > 0 && <section className="threads-export-bar">
      <div><FileDown size={22} /><span><strong>{selectedPosts.length} постов для отчёта</strong><small>К каждому посту будут добавлены доступные ответы и ссылки на оригиналы.</small></span></div>
      {!prepared.length || prepared.length !== selectedPosts.length
        ? <button className="button primary" disabled={preparing} onClick={() => void prepareReport()}>{preparing ? <LoaderCircle className="spin" size={18} /> : <MessageCircle size={18} />}{preparing ? `Собираем ответы ${preparationProgress}/${selectedPosts.length}` : "Подготовить PDF: посты + ответы"}</button>
        : <button className="button primary" onClick={() => void exportPdf()}><FileDown size={18} />Выгрузить в PDF</button>}
    </section>}

    {prepared.length > 0 && <section className="threads-pdf-report" id="threads-pdf-report">
      <header><div><AtSign size={28} /><span><small>THREADS SIGNAL REPORT</small><h2>{query}</h2><p>{prepared.length} выбранных постов · {prepared.reduce((sum, item) => sum + item.replies.length, 0)} ответов · {new Date().toLocaleString("ru-RU")}</p></span></div><button className="button primary" disabled={preparing} onClick={() => void exportPdf()}><FileDown size={17} />Выгрузить PDF</button></header>
      <div className="threads-report-items">{prepared.map((item, postIndex) => <article className="threads-report-thread" key={item.post.id}>
        <div className="threads-report-post"><b>{String(postIndex + 1).padStart(2, "0")}</b>{postAuthor(item.post)}<p>{item.post.text || "Пост без текста"}</p>{(item.post.mediaUrl || item.post.thumbnailUrl) && <div className="threads-report-media">{postPreview(item.post)}</div>}<footer><time><CalendarDays size={14} />{formatDate(item.post.timestamp)}</time><a href={item.post.permalink} target="_blank" rel="noreferrer">Открыть пост <ExternalLink size={13} /></a></footer></div>
        <section className="threads-report-replies"><header><MessageCircle size={18} /><strong>Ответы</strong><span>{item.replies.length}</span></header>
          {item.error && <div className="threads-reply-error"><ShieldAlert size={18} /><div><strong>Ответы недоступны</strong><p>{item.error}</p>{item.action && <small>{item.action}</small>}</div></div>}
          {item.warnings.map((warning) => <div className="threads-reply-warning" key={warning}>{warning}</div>)}
          {!item.error && item.replies.length === 0 && <p className="threads-no-replies">Threads не вернул ответов к этому посту.</p>}
          {item.replies.map((reply) => <article key={reply.id} style={{ "--reply-depth": Math.min(reply.depth, 4) } as CSSProperties}>{postAuthor(reply)}<p>{reply.text || "Ответ без текста"}</p>{reply.permalink && <a href={reply.permalink} target="_blank" rel="noreferrer">Оригинал ответа <ExternalLink size={12} /></a>}</article>)}
        </section>
      </article>)}</div>
    </section>}
  </div>;
}
