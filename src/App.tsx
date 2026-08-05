import { Bookmark, Menu, Settings2, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createCollection, fetchAds, fetchCollections, fetchFavoriteAds, setFavorite } from "./api";
import { AdCard } from "./components/AdCard";
import { CollectionPicker } from "./components/CollectionPicker";
import { CollectionsPanel } from "./components/CollectionsPanel";
import { CreativeModal } from "./components/CreativeModal";
import { FilterPanel } from "./components/FilterPanel";
import { LogsPage } from "./components/LogsPage";
import { Sidebar } from "./components/Sidebar";
import { ViewSettings } from "./components/ViewSettings";
import { EMPTY_FILTERS, type AdCreative, type AdFilters, type AdSource, type CreativeCollection } from "./shared/types";

function isFiltered(filters: AdFilters): boolean {
  return Object.entries(filters).some(([key, value]) => {
    if (key === "searchMode" || key === "mediaType") return false;
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  }) || filters.mediaType !== "all";
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
  const [collections, setCollections] = useState<CreativeCollection[]>([]);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [favoriteCandidate, setFavoriteCandidate] = useState<AdCreative | null>(null);
  const [columns, setColumns] = useState(4);
  const [compact, setCompact] = useState(false);
  const [infinite, setInfinite] = useState(true);
  const loaderRef = useRef<HTMLDivElement>(null);
  const loadRequestRef = useRef(0);

  const loadCollections = useCallback(async () => {
    setCollectionsLoading(true);
    try {
      setCollections(await fetchCollections());
    } catch {
      setCollections([]);
    } finally {
      setCollectionsLoading(false);
    }
  }, []);

  const load = useCallback(async (nextCursor?: string, append = false) => {
    const requestId = ++loadRequestRef.current;
    append ? setLoadingMore(true) : setLoading(true);
    if (!append) {
      setItems([]);
      setCursor(null);
    }
    setError("");
    try {
      const result = savedOnly
        ? await fetchFavoriteAds(selectedCollectionId ?? undefined)
        : await fetchAds(source, appliedFilters, nextCursor);
      if (requestId !== loadRequestRef.current) return;
      setItems((current) => {
        const nextItems = append ? [...current, ...result.items] : result.items;
        return [...new Map(nextItems.map((ad) => [ad.id, ad])).values()];
      });
      setCursor(result.nextCursor);
    } catch (loadError) {
      if (requestId !== loadRequestRef.current) return;
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить объявления");
      if (!append) setItems([]);
    } finally {
      if (requestId === loadRequestRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [source, appliedFilters, savedOnly, selectedCollectionId]);

  useEffect(() => { if (activeView === "ads") void load(); }, [activeView, load]);

  useEffect(() => {
    if (savedOnly || favoriteCandidate) void loadCollections();
  }, [favoriteCandidate, loadCollections, savedOnly]);

  useEffect(() => {
    if (activeView !== "ads" || savedOnly || !infinite || !cursor || loadingMore) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void load(cursor, true);
    }, { rootMargin: "400px" });
    if (loaderRef.current) observer.observe(loaderRef.current);
    return () => observer.disconnect();
  }, [activeView, cursor, infinite, load, loadingMore, savedOnly]);

  const changeSource = (nextSource: AdSource) => {
    if (nextSource === source) return;
    setSource(nextSource);
    setDraftFilters({ ...EMPTY_FILTERS });
    setAppliedFilters({ ...EMPTY_FILTERS });
    loadRequestRef.current += 1;
    setItems([]);
    setCursor(null);
    setMobileNavOpen(false);
  };

  const changeSavedOnly = (value: boolean) => {
    if (value === savedOnly) return;
    loadRequestRef.current += 1;
    setItems([]);
    setCursor(null);
    setError("");
    setSelectedCollectionId(null);
    setSavedOnly(value);
  };

  const changeCollection = (collectionId: string | null) => {
    if (collectionId === selectedCollectionId) return;
    loadRequestRef.current += 1;
    setItems([]);
    setCursor(null);
    setError("");
    setSelectedCollectionId(collectionId);
  };

  const updateFavorite = (ad: AdCreative, nextValue: boolean) => {
    const update = (item: AdCreative) => item.id === ad.id ? { ...item, isFavorite: nextValue, savedCount: Math.max(0, item.savedCount + (nextValue ? 1 : -1)) } : item;
    setItems((current) => current.map(update));
    setSelectedAd((current) => current?.id === ad.id ? update(current) : current);
  };

  const toggleFavorite = async (ad: AdCreative) => {
    if (!ad.isFavorite) {
      setFavoriteCandidate(ad);
      return;
    }
    updateFavorite(ad, false);
    try {
      await setFavorite(ad, false);
      await loadCollections();
    } catch {
      setItems((current) => current.map((item) => item.id === ad.id ? ad : item));
      setSelectedAd((current) => current?.id === ad.id ? ad : current);
    }
  };

  const saveFavorite = async (ad: AdCreative, collectionId?: string) => {
    await setFavorite(ad, true, collectionId);
    updateFavorite(ad, true);
    await loadCollections();
  };

  const addCollection = async (name: string) => {
    const collection = await createCollection(name);
    setCollections((current) => [collection, ...current.filter((item) => item.id !== collection.id)]);
    return collection;
  };

  const visibleItems = useMemo(() => savedOnly ? items.filter((ad) => ad.isFavorite) : items, [items, savedOnly]);

  return (
    <div className="app-shell">
      <div className={`mobile-sidebar-backdrop ${mobileNavOpen ? "show" : ""}`} onClick={() => setMobileNavOpen(false)} />
      <div className={`sidebar-wrap ${mobileNavOpen ? "open" : ""}`}>
        <Sidebar activeView={activeView} onViewChange={(view) => { setActiveView(view); setMobileNavOpen(false); }} source={source} onSourceChange={changeSource} savedOnly={savedOnly} onSavedOnlyChange={changeSavedOnly} />
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

          {savedOnly && <CollectionsPanel collections={collections} selectedId={selectedCollectionId} loading={collectionsLoading} onSelect={changeCollection} onCreate={addCollection} />}

          {!savedOnly && <FilterPanel source={source} filters={draftFilters} onChange={setDraftFilters} canApply={isFiltered(draftFilters)} loading={loading} onApply={() => setAppliedFilters({ ...draftFilters })} onClear={() => { setDraftFilters({ ...EMPTY_FILTERS }); setAppliedFilters({ ...EMPTY_FILTERS }); }} />}

          <section className="results-section">
            <div className="results-toolbar">
              <div><h2>{savedOnly ? "Мои заметки" : "Креативы"}</h2></div>
              <div className="toolbar-actions">
                {!savedOnly && isFiltered(appliedFilters) && <button className="filter-chip" onClick={() => { setAppliedFilters({ ...EMPTY_FILTERS }); setDraftFilters({ ...EMPTY_FILTERS }); }}>Фильтры активны <X size={14} /></button>}
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
      {favoriteCandidate && <CollectionPicker ad={favoriteCandidate} collections={collections} loading={collectionsLoading} onClose={() => setFavoriteCandidate(null)} onCreate={addCollection} onSave={(collectionId) => saveFavorite(favoriteCandidate, collectionId)} />}
      {settingsOpen && <div className="drawer-backdrop" onClick={() => setSettingsOpen(false)} />}
      <ViewSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} columns={columns} onColumnsChange={setColumns} compact={compact} onCompactChange={setCompact} infinite={infinite} onInfiniteChange={setInfinite} />
    </div>
  );
}
