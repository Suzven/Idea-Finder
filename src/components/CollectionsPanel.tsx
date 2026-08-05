import { AlertTriangle, Bookmark, Folder, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { CreativeCollection } from "../shared/types";

interface CollectionsPanelProps {
  collections: CreativeCollection[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => Promise<CreativeCollection>;
  onDelete: (collection: CreativeCollection) => Promise<number>;
}

export function CollectionsPanel({ collections, selectedId, loading, onSelect, onCreate, onDelete }: CollectionsPanelProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<CreativeCollection | null>(null);
  const [deleting, setDeleting] = useState(false);

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

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setError("");
    try {
      await onDelete(deleteTarget);
      setDeleteTarget(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Не удалось удалить коллекцию");
    } finally {
      setDeleting(false);
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
        <button className={`collection-tab ${selectedId === null ? "active" : ""}`} onClick={() => onSelect(null)}><span><Bookmark size={16} /></span><strong>Все сохранённые</strong></button>
        {collections.map((collection) => <div key={collection.id} className={`collection-tab-wrap ${selectedId === collection.id ? "active" : ""}`}>
          <button className="collection-tab-main" onClick={() => onSelect(collection.id)}><span><Folder size={16} /></span><strong>{collection.name}</strong><small>{collection.itemCount}</small></button>
          <button className="collection-delete-trigger" onClick={() => setDeleteTarget(collection)} aria-label={`Удалить коллекцию ${collection.name}`} title="Удалить коллекцию"><Trash2 size={14} /></button>
        </div>)}
        {loading && !collections.length && <span className="collections-loading">Загружаем коллекции…</span>}
      </div>
      {deleteTarget && <div className="collection-delete-confirm">
        <span><AlertTriangle size={19} /></span>
        <div><strong>Удалить «{deleteTarget.name}»?</strong><p>Коллекция и {deleteTarget.itemCount} сохранённых креативов будут удалены безвозвратно.</p></div>
        <button className="button ghost small" disabled={deleting} onClick={() => setDeleteTarget(null)}>Отмена</button>
        <button className="button danger small" disabled={deleting} onClick={() => void remove()}><Trash2 size={14} />{deleting ? "Удаляем…" : "Удалить"}</button>
      </div>}
    </section>
  );
}
