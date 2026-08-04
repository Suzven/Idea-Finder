import { BarChart3, Bookmark, CircleHelp, Radar, Settings2 } from "lucide-react";
import type { AdSource } from "../shared/types";

interface SidebarProps {
  source: AdSource;
  onSourceChange: (source: AdSource) => void;
  savedOnly: boolean;
  onSavedOnlyChange: (value: boolean) => void;
}

export function Sidebar({ source, onSourceChange, savedOnly, onSavedOnlyChange }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark"><Radar size={22} strokeWidth={2.3} /></span>
        <span className="brand-name">SpyService</span>
      </div>

      <nav className="side-nav" aria-label="Главная навигация">
        <p className="nav-label">Источники</p>
        <button className={`nav-item ${source === "meta" && !savedOnly ? "active" : ""}`} onClick={() => { onSourceChange("meta"); onSavedOnlyChange(false); }}>
          <span className="source-glyph meta-glyph">M</span>
          <span>Реклама Meta</span>
        </button>
        <button className={`nav-item ${source === "tiktok" && !savedOnly ? "active" : ""}`} onClick={() => { onSourceChange("tiktok"); onSavedOnlyChange(false); }}>
          <span className="source-glyph tiktok-glyph">T</span>
          <span>TikTok Ads</span>
        </button>

        <p className="nav-label nav-label-spaced">Рабочее пространство</p>
        <button className={`nav-item ${savedOnly ? "active" : ""}`} onClick={() => onSavedOnlyChange(!savedOnly)}>
          <Bookmark size={18} />
          <span>Сохранённые</span>
        </button>
        <button className="nav-item muted" disabled>
          <BarChart3 size={18} />
          <span>Аналитика</span>
          <span className="soon">скоро</span>
        </button>
      </nav>

      <div className="sidebar-footer">
        <button className="nav-item"><Settings2 size={18} /><span>Настройки</span></button>
        <button className="nav-item"><CircleHelp size={18} /><span>Документация</span></button>
        <div className="profile-row">
          <span className="profile-avatar">OS</span>
          <span><strong>Workspace</strong><small>Private account</small></span>
        </div>
      </div>
    </aside>
  );
}
