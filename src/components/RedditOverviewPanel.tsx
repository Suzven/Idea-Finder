import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { CalendarDays, Check, ExternalLink, FileDown, LoaderCircle, MessageCircle, Search, ShieldAlert, Sparkles, ThumbsUp, X } from "lucide-react";
import { ApiRequestError, fetchRedditConversation, searchRedditPosts } from "../api";
import type { RedditComment, RedditPost, RedditSearchResponse } from "../shared/types";

interface PreparedRedditPost {
  post: RedditPost;
  comments: RedditComment[];
  warnings: string[];
  truncated: boolean;
  error?: string;
  action?: string;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Дата не указана" : parsed.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("ru-RU", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function RedditIdentity({ author, subreddit, timestamp }: { author: string; subreddit?: string; timestamp: string }) {
  return <div className="reddit-identity"><span aria-hidden="true">👤</span><div><strong>u/{author}</strong><small>{subreddit ? `${subreddit} · ` : ""}{formatDate(timestamp)}</small></div></div>;
}

export function RedditOverviewPanel() {
  const [query, setQuery] = useState("");
  const [postLimit, setPostLimit] = useState(10);
  const [maxDepth, setMaxDepth] = useState(4);
  const [loading, setLoading] = useState(false);
  const [posts, setPosts] = useState<RedditPost[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [source, setSource] = useState<RedditSearchResponse["source"]>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [errorAction, setErrorAction] = useState("");
  const [prepared, setPrepared] = useState<PreparedRedditPost[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [preparationProgress, setPreparationProgress] = useState(0);

  const selectedPosts = useMemo(() => posts.filter((post) => selectedIds.has(post.id)), [posts, selectedIds]);

  const runSearch = async () => {
    const cleanQuery = query.trim();
    if (!cleanQuery) return;
    setLoading(true);
    setError("");
    setErrorAction("");
    setPosts([]);
    setWarnings([]);
    setSelectedIds(new Set());
    setPrepared([]);
    try {
      const result = await searchRedditPosts({ query: cleanQuery, limit: postLimit, sort: "new" });
      setPosts(result.posts);
      setWarnings(result.warnings);
      setSource(result.source);
    } catch (searchError) {
      const apiError = searchError instanceof ApiRequestError ? searchError : null;
      setError(searchError instanceof Error ? searchError.message : "Не удалось выполнить поиск в Reddit.");
      setErrorAction(apiError?.action ?? "");
    } finally {
      setLoading(false);
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

  const prepareReport = async () => {
    if (!selectedPosts.length) return;
    setPreparing(true);
    setPrepared([]);
    setPreparationProgress(0);
    const items: PreparedRedditPost[] = [];
    for (let index = 0; index < selectedPosts.length; index += 1) {
      const post = selectedPosts[index];
      try {
        items.push(await fetchRedditConversation(post, maxDepth));
      } catch (conversationError) {
        const apiError = conversationError instanceof ApiRequestError ? conversationError : null;
        items.push({
          post,
          comments: [],
          warnings: [],
          truncated: false,
          error: conversationError instanceof Error ? conversationError.message : "Комментарии к посту получить не удалось.",
          action: apiError?.action,
        });
      }
      setPreparationProgress(index + 1);
      setPrepared([...items]);
    }
    setPreparing(false);
  };

  const exportPdf = async () => {
    const images = [...document.querySelectorAll<HTMLImageElement>("#reddit-pdf-report img")];
    await Promise.race([
      Promise.all(images.map((image) => image.decode().catch(() => undefined))),
      new Promise((resolve) => window.setTimeout(resolve, 5_000)),
    ]);
    const previousTitle = document.title;
    document.title = `Reddit_${query.trim().replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 40)}_${new Date().toISOString().slice(0, 10)}`;
    document.documentElement.classList.add("printing-reddit");
    window.print();
    window.setTimeout(() => {
      document.documentElement.classList.remove("printing-reddit");
      document.title = previousTitle;
    }, 500);
  };

  return <div className="reddit-overview-panel">
    <section className="reddit-search-card">
      <header><div><span className="reddit-mark">r/</span><div><h2>Поиск пользовательских сигналов в Reddit</h2><p>Найдите публичные посты, отметьте важные обсуждения и выгрузите посты вместе с деревом комментариев в PDF.</p></div></div><span className="reddit-access-state"><i />Без входа в аккаунт</span></header>
      <form onSubmit={(event) => { event.preventDefault(); void runSearch(); }}>
        <label className="reddit-query-field"><span>Ключ для запроса</span><div><Search size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Например: клининг, mobile attribution или ai girlfriend" maxLength={512} disabled={loading} /><button className="button primary" disabled={loading || !query.trim()}>{loading ? <LoaderCircle className="spin" size={18} /> : <Search size={18} />}{loading ? "Ищем…" : "Найти посты"}</button></div></label>
        <div className="reddit-filter-grid">
          <label><span>Количество постов</span><input type="number" value={postLimit} min={1} max={100} onChange={(event) => setPostLimit(Math.max(1, Math.min(100, Number(event.target.value) || 1)))} disabled={loading} /><small>По умолчанию 10 · максимум 100</small></label>
          <label><span>Вложенность комментариев</span><input type="number" value={maxDepth} min={1} max={50} onChange={(event) => { setMaxDepth(Math.max(1, Math.min(50, Number(event.target.value) || 1))); setPrepared([]); }} disabled={preparing} /><small>По умолчанию 4 · максимум 50 уровней</small></label>
        </div>
      </form>
    </section>

    {error && <div className="reddit-error"><ShieldAlert size={21} /><div><strong>Reddit не выполнил запрос</strong><p>{error}</p>{errorAction && <small>{errorAction}</small>}</div></div>}
    {warnings.map((warning) => <div className="reddit-warning" key={warning}><Sparkles size={18} />{warning}</div>)}

    {posts.length > 0 && <section className="reddit-results">
      <header><div><h2>Найденные посты</h2><p>{posts.length} результатов · выбрано {selectedIds.size}</p></div><div><button type="button" className="button ghost" onClick={() => { setSelectedIds(new Set(posts.map((post) => post.id))); setPrepared([]); }}><Check size={16} />Выбрать все</button><button type="button" className="button ghost" disabled={!selectedIds.size} onClick={() => { setSelectedIds(new Set()); setPrepared([]); }}><X size={16} />Снять выбор</button></div></header>
      {source && <div className="reddit-source-note">Источник: {source === "reddit-json" ? "публичная структурированная выдача Reddit" : "Chromium"}</div>}
      <div className="reddit-post-grid">{posts.map((post) => {
        const selected = selectedIds.has(post.id);
        return <article key={post.id} className={selected ? "selected" : ""} onClick={() => togglePost(post.id)}>
          <button type="button" className="reddit-post-check" aria-label={selected ? "Снять выбор" : "Выбрать пост"}>{selected ? <Check size={16} /> : null}</button>
          <RedditIdentity author={post.author} subreddit={post.subreddit} timestamp={post.timestamp} />
          <h3>{post.title}</h3>
          {post.text && <p>{post.text}</p>}
          {post.thumbnailUrl && <img className="reddit-post-thumb" src={post.thumbnailUrl} alt="" loading="lazy" />}
          <footer><div><span><ThumbsUp size={14} />{formatCount(post.score)}</span><span><MessageCircle size={14} />{formatCount(post.commentCount)}</span>{post.isNsfw && <em>18+</em>}</div><a href={post.permalink} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>Оригинал <ExternalLink size={14} /></a></footer>
        </article>;
      })}</div>
    </section>}

    {selectedPosts.length > 0 && <section className="reddit-export-bar">
      <div><FileDown size={22} /><span><strong>{selectedPosts.length} постов для отчёта</strong><small>Для каждого поста соберём комментарии до глубины {maxDepth} и сохраним структуру веток.</small></span></div>
      {!prepared.length || prepared.length !== selectedPosts.length
        ? <button className="button primary" disabled={preparing} onClick={() => void prepareReport()}>{preparing ? <LoaderCircle className="spin" size={18} /> : <MessageCircle size={18} />}{preparing ? `Собираем комментарии ${preparationProgress}/${selectedPosts.length}` : "Собрать комментарии для PDF"}</button>
        : <button className="button primary" onClick={() => void exportPdf()}><FileDown size={18} />Выгрузить в PDF</button>}
    </section>}

    {prepared.length > 0 && <section className="reddit-pdf-report" id="reddit-pdf-report">
      <header><div><span className="reddit-mark">r/</span><span><small>REDDIT SIGNAL REPORT</small><h2>{query}</h2><p>{prepared.length} постов · {prepared.reduce((sum, item) => sum + item.comments.length, 0)} комментариев · глубина до {maxDepth} · {new Date().toLocaleString("ru-RU")}</p></span></div><button className="button primary" disabled={preparing} onClick={() => void exportPdf()}><FileDown size={17} />Выгрузить PDF</button></header>
      <div className="reddit-report-items">{prepared.map((item, postIndex) => <article className="reddit-report-thread" key={item.post.id}>
        <div className="reddit-report-post"><b>{String(postIndex + 1).padStart(2, "0")}</b><RedditIdentity author={item.post.author} subreddit={item.post.subreddit} timestamp={item.post.timestamp} /><h3>{item.post.title}</h3>{item.post.text && <p>{item.post.text}</p>}<footer><div><span><ThumbsUp size={14} />{formatCount(item.post.score)}</span><span><MessageCircle size={14} />{formatCount(item.post.commentCount)}</span></div><a href={item.post.permalink} target="_blank" rel="noreferrer">Открыть пост <ExternalLink size={13} /></a></footer></div>
        <section className="reddit-report-comments"><header><MessageCircle size={18} /><strong>Комментарии</strong><span>{item.comments.length}</span></header>
          {item.error && <div className="reddit-comment-error"><ShieldAlert size={18} /><div><strong>Комментарии недоступны</strong><p>{item.error}</p>{item.action && <small>{item.action}</small>}</div></div>}
          {item.warnings.map((warning) => <div className="reddit-comment-warning" key={warning}>{warning}</div>)}
          {!item.error && item.comments.length === 0 && <p className="reddit-no-comments">В публичной выдаче Reddit нет комментариев к этому посту.</p>}
          {item.comments.map((comment) => <article key={comment.id} style={{ "--comment-depth": Math.min(comment.depth, 8) } as CSSProperties}><RedditIdentity author={comment.author} timestamp={comment.timestamp} /><p>{comment.text || "Комментарий без текста"}</p><footer><span><ThumbsUp size={13} />{formatCount(comment.score)}</span>{comment.permalink && <a href={comment.permalink} target="_blank" rel="noreferrer">Оригинал <ExternalLink size={12} /></a>}</footer></article>)}
        </section>
      </article>)}</div>
    </section>}
  </div>;
}
