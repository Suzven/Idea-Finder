import { Bookmark, Folder, FolderPlus, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AdCreative, CreativeCollection } from "../shared/types";

interface CollectionPickerProps {
  ad: AdCreative;
  collections: CreativeCollection[];
  loading: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<CreativeCollection>;
  onSave: (collectionId?: string) => Promise<void>;
}

export function CollectionPicker({ ad, collections, loading, onClose, onCreate, onSave }: CollectionPickerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (selectedId === null && !loading) setSelectedId(collections[0]?.id ?? "");
  }, [collections, loading, selectedId]);

  const create = async () => {
    const normalizedName = name.trim();
    if (!normalizedName) return;
    setSubmitting(true);
    setError("");
    try {
      const collection = await onCreate(normalizedName);
      setSelectedId(collection.id);
      setName("");
      setCreating(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Не удалось создать коллекцию");
    } finally {
      setSubmitting(false);
    }
  };

  const save = async () => {
    setSubmitting(true);
    setError("");
    try {
      await onSave(selectedId || undefined);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить креатив");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="collection-picker-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="collection-picker" role="dialog" aria-modal="true" aria-label="Выбор коллекции">
        <header>
          <span className="collection-picker-icon"><Bookmark size={20} /></span>
          <div><h2>Сохранить в коллекцию</h2><p>{ad.advertiser}</p></div>
          <button className="collection-picker-close" onClick={onClose} aria-label="Закрыть"><X size={19} /></button>
        </header>

        <div className="collection-picker-list">
          {loading ? <div className="collection-picker-loading">Загружаем коллекции…</div> : <>
            <button className={selectedId === "" ? "selected" : ""} onClick={() => setSelectedId("")}>
              <span><Bookmark size={17} /></span><strong>Без коллекции</strong><small>Общее избранное</small>
            </button>
            {collections.map((collection) => <button key={collection.id} className={selectedId === collection.id ? "selected" : ""} onClick={() => setSelectedId(collection.id)}>
              <span><Folder size={17} /></span><strong>{collection.name}</strong><small>{collection.itemCount}</small>
            </button>)}
          </>}
        </div>

        {creating ? <div className="collection-create-row">
          <input autoFocus maxLength={120} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void create(); }} placeholder="Название коллекции" />
          <button className="button primary small" disabled={submitting || !name.trim()} onClick={() => void create()}>Создать</button>
        </div> : <button className="collection-create-link" onClick={() => setCreating(true)}><Plus size={16} />Создать новую коллекцию</button>}

        {error && <p className="collection-picker-error">{error}</p>}
        <footer>
          <button className="button ghost" onClick={onClose}>Отмена</button>
          <button className="button primary" disabled={loading || submitting} onClick={() => void save()}><FolderPlus size={17} />Сохранить</button>
        </footer>
      </section>
    </div>
  );
}
