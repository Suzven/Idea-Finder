import { Bookmark, Folder, Plus } from "lucide-react";
import { useState } from "react";
import type { CreativeCollection } from "../shared/types";

interface CollectionsPanelProps {
  collections: CreativeCollection[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => Promise<CreativeCollection>;
}

export function CollectionsPanel({ collections, selectedId, loading, onSelect, onCreate }: CollectionsPanelProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    const normalizedName = name.trim();
    if (!normalizedName) return;
    setSubmitting(true);
    setError("");
    try {
      const collection = await onCreate(normalizedName);
      setName("");
      setCreating(false);
      onSelect(collection.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Не удалось создать коллекцию");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="collections-panel">
      <header>
        <div><span className="eyebrow"><Folder size={13} /> LIBRARY</span><h2>Коллекции</h2></div>
        {creating ? <div className="collection-inline-create">
          <input autoFocus maxLength={120} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void create(); if (event.key === "Escape") setCreating(false); }} placeholder="Название коллекции" />
          <button className="button primary small" disabled={submitting || !name.trim()} onClick={() => void create()}>Создать</button>
          <button className="button ghost small" onClick={() => setCreating(false)}>Отмена</button>
        </div> : <button className="button ghost small" onClick={() => setCreating(true)}><Plus size={16} />Новая коллекция</button>}
      </header>
      {error && <p className="collection-panel-error">{error}</p>}
      <div className="collection-tabs">
        <button className={selectedId === null ? "active" : ""} onClick={() => onSelect(null)}><span><Bookmark size={16} /></span><strong>Все сохранённые</strong></button>
        {collections.map((collection) => <button key={collection.id} className={selectedId === collection.id ? "active" : ""} onClick={() => onSelect(collection.id)}>
          <span><Folder size={16} /></span><strong>{collection.name}</strong><small>{collection.itemCount}</small>
        </button>)}
        {loading && !collections.length && <span className="collections-loading">Загружаем коллекции…</span>}
      </div>
    </section>
  );
}
