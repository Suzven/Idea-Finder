import { Bookmark, Menu, Settings2, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAds, setFavorite } from "./api";
import { AdCard } from "./components/AdCard";
import { CreativeModal } from "./components/CreativeModal";
import { FilterPanel } from "./components/FilterPanel";
import { LogsPage } from "./components/LogsPage";
import { Sidebar } from "./components/Sidebar";
import { ViewSettings } from "./components/ViewSettings";
import { EMPTY_FILTERS, type AdCreative, type AdFilters, type AdSource } from "./shared/types";

function isFiltered(filters: AdFilters): boolean {
  return Object.entries(filters).some(([key, value]) => key !== "searchMode" && key !== "mediaType" && Boolean(value)) || filters.mediaType !== "all";
}

export default function App() {
  const [activeView, setActiveView] = useState<"ads" | "logs">("ads");
  const [source, setSource] = useState<AdSource>("meta");
  const [draftFilters, setDraftFilters] = useState<AdFilters>({ ...EMPTY_FILTERS });
  const [appliedFilters, setAppliedFilters] = useState<AdFilters>({ ...EMPTY_FILTERS });
  const [items, setItems] = useState<AdCreative[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [selectedAd, setSelectedAd] = useState<AdCreative | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [savedOnly, setSavedOnly] = useState(false);
  const [columns, setColumns] = useState(4);
  const [compact, setCompact] = useState(false);
  const [infinite, setInfinite] = useState(true);
  const loaderRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (nextCursor?: string, append = false) => {
    append ? setLoadingMore(true) : setLoading(true);
    setError("");
    try {
      const result = await fetchAds(source, appliedFilters, nextCursor);
      setItems((current) => append ? [...current, ...result.items] : result.items);
      setCursor(result.nextCursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить объявления");
      if (!append) setItems([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [source, appliedFilters]);

  useEffect(() => { if (activeView === "ads") void load(); }, [activeView, load]);

  useEffect(() => {
    if (activeView !== "ads" || !infinite || !cursor || loadingMore) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void load(cursor, true);
    }, { rootMargin: "400px" });
    if (loaderRef.current) observer.observe(loaderRef.current);
    return () => observer.disconnect();
  }, [activeView, cursor, infinite, load, loadingMore]);

  const changeSource = (nextSource: AdSource) => {
    if (nextSource === source) return;
    setSource(nextSource);
    setDraftFilters({ ...EMPTY_FILTERS });
    setAppliedFilters({ ...EMPTY_FILTERS });
    setMobileNavOpen(false);
  };

  const toggleFavorite = async (ad: AdCreative) => {
    const nextValue = !ad.isFavorite;
    const update = (item: AdCreative) => item.id === ad.id ? { ...item, isFavorite: nextValue, savedCount: item.savedCount + (nextValue ? 1 : -1) } : item;
    setItems((current) => current.map(update));
    setSelectedAd((current) => current?.id === ad.id ? update(current) : current);
    try {
      await setFavorite(ad, nextValue);
    } catch {
      setItems((current) => current.map((item) => item.id === ad.id ? ad : item));
      setSelectedAd((current) => current?.id === ad.id ? ad : current);
    }
  };

  const visibleItems = useMemo(() => savedOnly ? items.filter((ad) => ad.isFavorite) : items, [items, savedOnly]);

  return (
    <div className="app-shell">
      <div className={`mobile-sidebar-backdrop ${mobileNavOpen ? "show" : ""}`} onClick={() => setMobileNavOpen(false)} />
      <div className={`sidebar-wrap ${mobileNavOpen ? "open" : ""}`}>
        <Sidebar activeView={activeView} onViewChange={(view) => { setActiveView(view); setMobileNavOpen(false); }} source={source} onSourceChange={changeSource} savedOnly={savedOnly} onSavedOnlyChange={setSavedOnly} />
      </div>

      <main className="main-content">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileNavOpen(true)} aria-label="Открыть меню"><Menu size={21} /></button>
          <div className="breadcrumb"><span>{activeView === "logs" ? "Система" : "Библиотека рекламы"}</span><span>/</span><strong>{activeView === "logs" ? "Логи интеграций" : source === "meta" ? "Meta Ads" : "TikTok Ads"}</strong></div>
        </header>

        {activeView === "logs" ? <LogsPage /> : <div className="page-wrap">
          <section className="page-intro">
            <div>
              <span className="eyebrow"><Sparkles size={13} /> AD INTELLIGENCE</span>
              <h1>{savedOnly ? "Сохранённые креативы" : source === "meta" ? "Реклама Meta" : "TikTok Ads"}</h1>
              <p>{savedOnly ? "Ваша личная библиотека сильных рекламных решений." : "Находите устойчивые связки, изучайте подачу и сохраняйте идеи для новых кампаний."}</p>
            </div>
          </section>

          {!savedOnly && <FilterPanel source={source} filters={draftFilters} onChange={setDraftFilters} canApply={isFiltered(draftFilters)} loading={loading} onApply={() => setAppliedFilters({ ...draftFilters })} onClear={() => { setDraftFilters({ ...EMPTY_FILTERS }); setAppliedFilters({ ...EMPTY_FILTERS }); }} />}

          <section className="results-section">
            <div className="results-toolbar">
              <div><h2>{savedOnly ? "Мои заметки" : "Креативы"}</h2></div>
              <div className="toolbar-actions">
                {isFiltered(appliedFilters) && <button className="filter-chip" onClick={() => { setAppliedFilters({ ...EMPTY_FILTERS }); setDraftFilters({ ...EMPTY_FILTERS }); }}>Фильтры активны <X size={14} /></button>}
                <button className="button ghost small"><Bookmark size={16} />Сохранённые</button>
                <button className="button ghost small" onClick={() => setSettingsOpen(true)}><Settings2 size={16} />Вид</button>
              </div>
            </div>

            {error && <div className="error-state"><strong>Не удалось получить данные</strong><span>{error}</span><button className="button primary" onClick={() => void load()}>Повторить</button></div>}
            {loading && !items.length ? <div className="skeleton-grid">{Array.from({ length: 8 }).map((_, index) => <span key={index} />)}</div> : null}
            {!loading && !error && !visibleItems.length ? <div className="empty-state"><span><Bookmark size={25} /></span><h3>{savedOnly ? "Пока ничего не сохранено" : "Ничего не найдено"}</h3><p>{savedOnly ? "Добавляйте сильные объявления в заметки — они появятся здесь." : "Попробуйте расширить географию или очистить часть фильтров."}</p></div> : null}

            <div className={`ads-grid source-${source} columns-${columns} ${compact ? "compact" : ""}`}>
              {visibleItems.map((ad) => <AdCard key={ad.id} ad={ad} compact={compact} onOpen={setSelectedAd} onFavorite={(item) => void toggleFavorite(item)} />)}
            </div>
            <div ref={loaderRef} className="load-sentinel">
              {loadingMore && <span className="loader"><i /><i /><i /></span>}
              {!infinite && cursor && <button className="button ghost" onClick={() => void load(cursor, true)}>Показать ещё</button>}
            </div>
          </section>
        </div>}
      </main>

      {selectedAd && <CreativeModal ad={selectedAd} onClose={() => setSelectedAd(null)} onFavorite={(ad) => void toggleFavorite(ad)} />}
      {settingsOpen && <div className="drawer-backdrop" onClick={() => setSettingsOpen(false)} />}
      <ViewSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} columns={columns} onColumnsChange={setColumns} compact={compact} onCompactChange={setCompact} infinite={infinite} onInfiniteChange={setInfinite} />
    </div>
  );
}
