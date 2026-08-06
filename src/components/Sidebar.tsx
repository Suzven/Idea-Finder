import { Activity, BarChart3, Bookmark, LogOut, Radar, Settings2 } from "lucide-react";
import type { AdSource, AuthUser } from "../shared/types";

interface SidebarProps {
  activeView: "ads" | "logs" | "analytics";
  onViewChange: (view: "ads" | "logs" | "analytics") => void;
  source: AdSource;
  onSourceChange: (source: AdSource) => void;
  savedOnly: boolean;
  onSavedOnlyChange: (value: boolean) => void;
  onOpenSettings: () => void;
  user: AuthUser;
  onLogout: () => void;
}

export function Sidebar({ activeView, onViewChange, source, onSourceChange, savedOnly, onSavedOnlyChange, onOpenSettings, user, onLogout }: SidebarProps) {
  const initials = user.displayName.split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || user.username.slice(0, 2).toUpperCase();
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark"><Radar size={22} strokeWidth={2.3} /></span>
        <span className="brand-name">SpyService</span>
      </div>

      <nav className="side-nav" aria-label="Главная навигация">
        <p className="nav-label">Источники</p>
        <button className={`nav-item ${activeView === "ads" && source === "meta" && !savedOnly ? "active" : ""}`} onClick={() => { onViewChange("ads"); onSourceChange("meta"); onSavedOnlyChange(false); }}>
          <span className="source-glyph meta-glyph">M</span>
          <span>Реклама Meta</span>
        </button>
        <button className={`nav-item ${activeView === "ads" && source === "tiktok" && !savedOnly ? "active" : ""}`} onClick={() => { onViewChange("ads"); onSourceChange("tiktok"); onSavedOnlyChange(false); }}>
          <span className="source-glyph tiktok-glyph">T</span>
          <span>TikTok Ads</span>
        </button>

        <p className="nav-label nav-label-spaced">Рабочее пространство</p>
        <button className={`nav-item ${activeView === "ads" && savedOnly ? "active" : ""}`} onClick={() => { onViewChange("ads"); onSavedOnlyChange(true); }}>
          <Bookmark size={18} />
          <span>Сохранённые</span>
        </button>
        <button className={`nav-item ${activeView === "logs" ? "active" : ""}`} onClick={() => onViewChange("logs")}>
          <Activity size={18} />
          <span>Логи</span>
          <i className="live-dot" />
        </button>
        <button className={`nav-item ${activeView === "analytics" ? "active" : ""}`} onClick={() => onViewChange("analytics")}>
          <BarChart3 size={18} />
          <span>AI Аналитика</span>
        </button>
      </nav>

      <div className="sidebar-footer">
        <button className="nav-item" onClick={onOpenSettings}><Settings2 size={18} /><span>Настройки</span></button>
        <div className="profile-row" title={`Вы вошли как ${user.username}`}>
          <span className="profile-avatar">{initials}</span>
          <span><strong>{user.displayName}</strong><small>@{user.username} · {user.role}</small></span>
          <button type="button" onClick={onLogout} aria-label="Выйти из аккаунта" title="Выйти"><LogOut size={17} /></button>
        </div>
      </div>
    </aside>
  );
}
