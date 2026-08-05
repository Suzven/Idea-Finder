import { CalendarDays, Check, ChevronDown, Eraser, Search, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { META_COUNTRIES, META_LANGUAGES, type FilterOption } from "../shared/filterOptions";
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

function Field({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <div className={`filter-field ${wide ? "wide" : ""}`}><span>{label}</span>{children}</div>;
}

function Select<Value extends string>({ value, onChange, children, ariaLabel }: { value: Value; onChange: (value: Value) => void; children: React.ReactNode; ariaLabel: string }) {
  return <span className="select-wrap"><select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value as Value)}>{children}</select><ChevronDown size={15} /></span>;
}

function MultiSelect({
  value, options, onChange, ariaLabel, emptyLabel, searchPlaceholder, allValue,
}: {
  value: string[];
  options: FilterOption[];
  onChange: (value: string[]) => void;
  ariaLabel: string;
  emptyLabel: string;
  searchPlaceholder: string;
  allValue?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  useEffect(() => { if (!open) setQuery(""); }, [open]);

  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ru");
    if (!normalized) return options;
    return options.filter((option) => `${option.label} ${option.value}`.toLocaleLowerCase("ru").includes(normalized));
  }, [options, query]);

  const selectedLabels = value.map((selected) => options.find((option) => option.value === selected)?.label ?? selected);
  const summary = selectedLabels.length === 0
    ? emptyLabel
    : selectedLabels.length <= 2
      ? selectedLabels.join(", ")
      : `${selectedLabels[0]} +${selectedLabels.length - 1}`;

  const toggle = (optionValue: string) => {
    if (allValue && optionValue === allValue) {
      onChange([allValue]);
      return;
    }
    const current = allValue ? value.filter((selected) => selected !== allValue) : value;
    const next = current.includes(optionValue)
      ? current.filter((selected) => selected !== optionValue)
      : [...current, optionValue];
    onChange(next.length > 0 || !allValue ? next : [allValue]);
  };

  return <div className={`multi-select ${open ? "open" : ""}`} ref={rootRef}>
    <button type="button" className="multi-select-trigger" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <span title={selectedLabels.join(", ")}>{summary}</span>
      {value.length > 0 && <b>{value.length}</b>}
      <ChevronDown size={15} />
    </button>
    {open && <div className="multi-select-menu">
      <div className="multi-select-search"><Search size={15} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={searchPlaceholder} /></div>
      <div className="multi-select-menu-head"><span>Выбрано: {value.length}</span>{value.length > 0 && <button type="button" onClick={() => onChange(allValue ? [allValue] : [])}>Сбросить</button>}</div>
      <div className="multi-select-options" role="listbox" aria-label={ariaLabel} aria-multiselectable="true">
        {filteredOptions.map((option) => {
          const checked = value.includes(option.value);
          return <button type="button" role="option" aria-selected={checked} className={checked ? "selected" : ""} key={option.value} onClick={() => toggle(option.value)}>
            <i>{checked && <Check size={13} strokeWidth={3} />}</i><span>{option.label}</span><small>{option.value.toUpperCase()}</small>
          </button>;
        })}
        {filteredOptions.length === 0 && <p>Ничего не найдено</p>}
      </div>
    </div>}
  </div>;
}

export function FilterPanel({ source, filters, onChange, onApply, onClear, canApply, loading }: FilterPanelProps) {
  const set = <Key extends keyof AdFilters>(key: Key, value: AdFilters[Key]) => onChange({ ...filters, [key]: value });

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
            <Field label="География показа"><MultiSelect ariaLabel="География показа" value={filters.country} options={META_COUNTRIES} onChange={(value) => set("country", value)} emptyLabel="Выберите страны" searchPlaceholder="Найти страну или ISO-код" allValue="ALL" /></Field>
            <Field label="Приложение"><input value={filters.app} onChange={(event) => set("app", event.target.value)} placeholder="App Store / Google Play URL" /></Field>
            <Field label="Тип медиаконтента"><Select ariaLabel="Тип медиаконтента" value={filters.mediaType} onChange={(value) => set("mediaType", value)}><option value="all">Любой формат</option><option value="video">Видео</option><option value="image">Изображение</option><option value="carousel">Карусель</option></Select></Field>
            <Field label="Язык текста"><MultiSelect ariaLabel="Язык текста" value={filters.language} options={META_LANGUAGES} onChange={(value) => set("language", value)} emptyLabel="Все языки" searchPlaceholder="Найти язык или ISO-код" /></Field>
            <Field label="Платформа"><Select ariaLabel="Платформа" value={filters.platform} onChange={(value) => set("platform", value)}><option value="">Все плейсменты</option><option value="Facebook">Facebook</option><option value="Instagram">Instagram</option><option value="Messenger">Messenger</option><option value="Audience">Audience Network</option><option value="WhatsApp">WhatsApp</option><option value="Threads">Threads</option></Select></Field>
            <Field label="Дата создания"><div className="range-row date-row"><CalendarDays size={16} /><input type="date" value={filters.dateFrom} onChange={(event) => set("dateFrom", event.target.value)} /><span>—</span><input type="date" value={filters.dateTo} onChange={(event) => set("dateTo", event.target.value)} /></div></Field>
            <Field label="Охват"><div className="range-row"><input inputMode="numeric" value={filters.reachFrom} onChange={(event) => set("reachFrom", event.target.value)} placeholder="от 0" /><span>—</span><input inputMode="numeric" value={filters.reachTo} onChange={(event) => set("reachTo", event.target.value)} placeholder="до ∞" /></div></Field>
          </>
        ) : (
          <>
            <Field label="Advertiser name" wide><div className="input-icon"><Search size={17} /><input value={filters.advertiser} onChange={(event) => set("advertiser", event.target.value)} placeholder="Имя рекламодателя или ключевое слово" /></div></Field>
            <Field label="Страна"><MultiSelect ariaLabel="Страна" value={filters.country} options={META_COUNTRIES} onChange={(value) => set("country", value)} emptyLabel="Выберите страны" searchPlaceholder="Найти страну или ISO-код" allValue="ALL" /></Field>
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
