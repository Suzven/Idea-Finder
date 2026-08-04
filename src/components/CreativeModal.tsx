import { Bookmark, CalendarDays, Download, ExternalLink, Globe2, ImageOff, Layers3, X } from "lucide-react";
import { useEffect } from "react";
import { useResolvedAdMedia } from "../hooks/useResolvedAdMedia";
import type { AdCreative } from "../shared/types";

interface CreativeModalProps {
  ad: AdCreative;
  onClose: () => void;
  onFavorite: (ad: AdCreative) => void;
}

export function CreativeModal({ ad, onClose, onFavorite }: CreativeModalProps) {
  const { ad: resolvedAd, loading: mediaLoading, error: mediaError } = useResolvedAdMedia(ad);
  ad = resolvedAd;
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    document.body.classList.add("modal-open");
    return () => { window.removeEventListener("keydown", close); document.body.classList.remove("modal-open"); };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="creative-modal" role="dialog" aria-modal="true" aria-label={`Креатив ${ad.advertiser}`}>
        <button className="modal-close" onClick={onClose} aria-label="Закрыть"><X size={20} /></button>
        <div className={`modal-media ${ad.source}`}>
          {ad.mediaUrl
            ? ad.mediaType === "video" ? <video controls poster={ad.thumbnailUrl} src={ad.mediaUrl} /> : <img src={ad.mediaUrl || ad.thumbnailUrl} alt={ad.headline} />
            : <div className="modal-media-placeholder"><ImageOff size={36} /><strong>{mediaLoading ? "Загружаем креатив из Meta…" : mediaError ? "Не удалось извлечь креатив из snapshot" : "Креатив доступен в оригинале Meta"}</strong></div>}
          <div className="modal-media-actions">
            {ad.sourceUrl && <a className="round-action" href={ad.sourceUrl} target="_blank" rel="noreferrer" title="Открыть оригинал"><ExternalLink size={18} /></a>}
            {ad.mediaType === "video" && ad.mediaUrl && <a className="round-action" href={ad.mediaUrl} download target="_blank" rel="noreferrer" title="Скачать видео"><Download size={18} /></a>}
          </div>
        </div>
        <div className="modal-details">
          <div className="modal-brand"><span className="avatar large">{ad.advertiserAvatar ? <img src={ad.advertiserAvatar} alt="" /> : ad.advertiser.slice(0, 1)}</span><div><span className="eyebrow">{ad.source === "meta" ? "META AD" : "TIKTOK AD"}</span><h2>{ad.advertiser}</h2></div></div>
          <button className={`save-wide ${ad.isFavorite ? "saved" : ""}`} onClick={() => onFavorite(ad)}><Bookmark size={17} fill={ad.isFavorite ? "currentColor" : "none"} />{ad.isFavorite ? "Сохранено" : "В заметки"}</button>
          <div className="detail-metrics">
            <span><CalendarDays size={16} /><small>Запущено</small><strong>{new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(ad.startedAt))}</strong></span>
            <span><Globe2 size={16} /><small>География</small><strong>{ad.countryName}</strong></span>
            <span><Layers3 size={16} /><small>Площадки</small><strong>{ad.platforms.join(", ")}</strong></span>
          </div>
          <div className="modal-copy"><h1>{ad.headline}</h1><p>{ad.body}</p></div>
          {ad.appUrl && <p className="modal-display-url">Сайт в объявлении: <strong>{ad.appUrl}</strong></p>}
          <div className="modal-bottom">
            {ad.landingUrl ? <a className="button primary grow" href={ad.landingUrl} target="_blank" rel="noreferrer">{ad.cta}<ExternalLink size={16} /></a> : <span className="button disabled grow">Ссылка не предоставлена</span>}
            {ad.sourceUrl && <a className="button ghost" href={ad.sourceUrl} target="_blank" rel="noreferrer">Оригинал</a>}
          </div>
        </div>
      </section>
    </div>
  );
}
