import { CalendarDays, ChevronDown, Eraser, Search, SlidersHorizontal } from "lucide-react";
import type { AdFilters, AdSource } from "../shared/types";

interface FilterPanelProps {
  source: AdSource;
  filters: AdFilters;
  onChange: (filters: AdFilters) => void;
  onApply: () => void;
  onClear: () => void;
  canApply: boolean;
  loading: boolean;
}

const countries = [
  ["", "Все страны"], ["DE", "Германия"], ["PL", "Польша"], ["FR", "Франция"],
  ["IT", "Италия"], ["ES", "Испания"], ["NL", "Нидерланды"], ["SE", "Швеция"],
  ["PT", "Португалия"], ["DK", "Дания"], ["AT", "Австрия"], ["IE", "Ирландия"],
];

function Field({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={`filter-field ${wide ? "wide" : ""}`}><span>{label}</span>{children}</label>;
}

function Select({ value, onChange, children, ariaLabel }: { value: string; onChange: (value: string) => void; children: React.ReactNode; ariaLabel: string }) {
  return <span className="select-wrap"><select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}>{children}</select><ChevronDown size={15} /></span>;
}

export function FilterPanel({ source, filters, onChange, onApply, onClear, canApply, loading }: FilterPanelProps) {
  const set = (key: keyof AdFilters, value: string) => onChange({ ...filters, [key]: value });

  return (
    <section className="filters-card" aria-label="Фильтры поиска">
      <div className="filters-heading">
        <div><SlidersHorizontal size={18} /><strong>Точный поиск</strong><span>Соберите нужную выборку креативов</span></div>
        <span className="keyboard-hint">⌘ K</span>
      </div>

      <div className="filter-grid">
        {source === "meta" ? (
          <>
            <Field label="Текст для поиска" wide>
              <div className="search-combo">
                <Search size={17} />
                <input value={filters.search} onChange={(event) => set("search", event.target.value)} placeholder="Название бренда, оффер или текст объявления" />
                <Select ariaLabel="Режим поиска" value={filters.searchMode} onChange={(value) => set("searchMode", value)}>
                  <option value="all">По всему тексту</option><option value="exact">Точная фраза</option><option value="media">Текст с медиа</option>
                </Select>
              </div>
            </Field>
            <Field label="География показа"><Select ariaLabel="География показа" value={filters.country} onChange={(value) => set("country", value)}>{countries.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</Select></Field>
            <Field label="Приложение"><input value={filters.app} onChange={(event) => set("app", event.target.value)} placeholder="App Store / Google Play URL" /></Field>
            <Field label="Тип медиаконтента"><Select ariaLabel="Тип медиаконтента" value={filters.mediaType} onChange={(value) => set("mediaType", value)}><option value="all">Любой формат</option><option value="video">Видео</option><option value="image">Изображение</option><option value="carousel">Карусель</option></Select></Field>
            <Field label="Язык текста"><Select ariaLabel="Язык текста" value={filters.language} onChange={(value) => set("language", value)}><option value="">Все языки</option><option value="en">Английский</option><option value="de">Немецкий</option><option value="fr">Французский</option><option value="es">Испанский</option><option value="it">Итальянский</option><option value="pl">Польский</option></Select></Field>
            <Field label="Платформа"><Select ariaLabel="Платформа" value={filters.platform} onChange={(value) => set("platform", value)}><option value="">Все плейсменты</option><option value="Facebook">Facebook</option><option value="Instagram">Instagram</option><option value="Messenger">Messenger</option><option value="Audience">Audience Network</option><option value="WhatsApp">WhatsApp</option><option value="Threads">Threads</option></Select></Field>
            <Field label="Дата создания"><div className="range-row date-row"><CalendarDays size={16} /><input type="date" value={filters.dateFrom} onChange={(event) => set("dateFrom", event.target.value)} /><span>—</span><input type="date" value={filters.dateTo} onChange={(event) => set("dateTo", event.target.value)} /></div></Field>
            <Field label="Охват"><div className="range-row"><input inputMode="numeric" value={filters.reachFrom} onChange={(event) => set("reachFrom", event.target.value)} placeholder="от 0" /><span>—</span><input inputMode="numeric" value={filters.reachTo} onChange={(event) => set("reachTo", event.target.value)} placeholder="до ∞" /></div></Field>
          </>
        ) : (
          <>
            <Field label="Advertiser name" wide><div className="input-icon"><Search size={17} /><input value={filters.advertiser} onChange={(event) => set("advertiser", event.target.value)} placeholder="Имя рекламодателя или ключевое слово" /></div></Field>
            <Field label="Страна"><Select ariaLabel="Страна" value={filters.country} onChange={(value) => set("country", value)}>{countries.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</Select></Field>
            <Field label="Формат объявления"><Select ariaLabel="Формат объявления" value={filters.mediaType} onChange={(value) => set("mediaType", value)}><option value="all">Все форматы</option><option value="video">Видео</option><option value="image">Изображение</option></Select></Field>
            <Field label="Дата запуска"><div className="range-row date-row"><CalendarDays size={16} /><input type="date" value={filters.dateFrom} onChange={(event) => set("dateFrom", event.target.value)} /><span>—</span><input type="date" value={filters.dateTo} onChange={(event) => set("dateTo", event.target.value)} /></div></Field>
            <Field label="Дней в работе"><div className="range-row"><input inputMode="numeric" value={filters.durationFrom} onChange={(event) => set("durationFrom", event.target.value)} placeholder="от 0" /><span>—</span><input inputMode="numeric" value={filters.durationTo} onChange={(event) => set("durationTo", event.target.value)} placeholder="до ∞" /></div></Field>
            <Field label="Сохранений"><div className="range-row"><input inputMode="numeric" value={filters.savedFrom} onChange={(event) => set("savedFrom", event.target.value)} placeholder="от 0" /><span>—</span><input inputMode="numeric" value={filters.savedTo} onChange={(event) => set("savedTo", event.target.value)} placeholder="до ∞" /></div></Field>
          </>
        )}
      </div>

      <div className="filter-actions">
        <button className="button ghost" onClick={onClear}><Eraser size={17} />Очистить</button>
        <span className="filter-help">Заполните хотя бы одно поле, чтобы применить фильтры</span>
        <button className="button primary" disabled={!canApply || loading} onClick={onApply}><Search size={17} />{loading ? "Ищем…" : "Найти креативы"}</button>
      </div>
    </section>
  );
}
