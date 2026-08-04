import { Grid2X2, LayoutGrid, Rows3, X } from "lucide-react";

interface ViewSettingsProps {
  open: boolean;
  onClose: () => void;
  columns: number;
  onColumnsChange: (columns: number) => void;
  compact: boolean;
  onCompactChange: (value: boolean) => void;
  infinite: boolean;
  onInfiniteChange: (value: boolean) => void;
}

export function ViewSettings({ open, onClose, columns, onColumnsChange, compact, onCompactChange, infinite, onInfiniteChange }: ViewSettingsProps) {
  return (
    <div className={`settings-drawer ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="drawer-title"><div><span className="eyebrow">ПЕРСОНАЛИЗАЦИЯ</span><h2>Вид выдачи</h2></div><button onClick={onClose} aria-label="Закрыть"><X size={20} /></button></div>
      <div className="setting-block"><span className="setting-label">Плотность карточек</span><div className="segmented"><button className={!compact ? "active" : ""} onClick={() => onCompactChange(false)}><Rows3 size={17} />Подробно</button><button className={compact ? "active" : ""} onClick={() => onCompactChange(true)}><Grid2X2 size={17} />Компактно</button></div></div>
      <div className="setting-block"><span className="setting-label">Карточек в ряду</span><p>На небольших экранах количество колонок адаптируется автоматически.</p><div className="column-options">{[3, 4, 5].map((value) => <button key={value} className={columns === value ? "active" : ""} onClick={() => onColumnsChange(value)}><LayoutGrid size={16} />{value}</button>)}</div></div>
      <label className="toggle-setting"><span><strong>Бесконечная прокрутка</strong><small>Подгружать следующую страницу во время просмотра.</small></span><input type="checkbox" checked={infinite} onChange={(event) => onInfiniteChange(event.target.checked)} /><i /></label>
    </div>
  );
}
