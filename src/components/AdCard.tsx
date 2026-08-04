import { Bookmark, ExternalLink, ImageOff, Images, Play, TrendingUp } from "lucide-react";
import { useResolvedAdMedia } from "../hooks/useResolvedAdMedia";
import type { AdCreative } from "../shared/types";

interface AdCardProps {
  ad: AdCreative;
  onOpen: (ad: AdCreative) => void;
  onFavorite: (ad: AdCreative) => void;
  compact: boolean;
}

const formatNumber = (value?: number) => value === undefined ? "—" : new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const formatDate = (value: string) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(new Date(value));

export function AdCard({ ad, onOpen, onFavorite, compact }: AdCardProps) {
  const { ad: resolvedAd, loading: mediaLoading, error: mediaError } = useResolvedAdMedia(ad);
  ad = resolvedAd;
  const avatar = <span className="avatar">{ad.advertiserAvatar ? <img src={ad.advertiserAvatar} alt="" loading="lazy" /> : ad.advertiser.slice(0, 1)}</span>;
  const media = (
    <div className="card-media">
      {ad.mediaType === "video" && ad.mediaUrl
        ? <video controls preload="metadata" poster={ad.thumbnailUrl || undefined} src={ad.mediaUrl} onClick={(event) => event.stopPropagation()} />
        : ad.thumbnailUrl || ad.mediaUrl
          ? <img src={ad.thumbnailUrl || ad.mediaUrl} alt={`Креатив ${ad.advertiser}`} loading="lazy" />
          : <div className={`media-placeholder ${mediaLoading ? "loading" : ""}`}><ImageOff size={28} /><span>{mediaLoading ? "Загружаем креатив…" : mediaError ? "Не удалось извлечь креатив" : "Креатив доступен в Meta"}</span></div>}
      <span className="media-shade" />
      {ad.mediaType === "video" && !ad.mediaUrl && <span className="play-button"><Play size={18} fill="currentColor" /></span>}
      {ad.mediaType === "carousel" && <span className="media-type"><Images size={14} /> {ad.carousel?.length ?? 2}</span>}
      <div className="media-metrics"><span><TrendingUp size={13} /> {formatNumber(ad.reach)}</span><span>{ad.daysActive} дн.</span></div>
    </div>
  );

  if (ad.source === "tiktok") {
    return (
      <article className="ad-card tiktok-card" onClick={() => onOpen(ad)}>
        {media}
        <div className="tiktok-overlay">
          <div className="card-advertiser">{avatar}<span><strong>{ad.advertiser}</strong><small>{formatDate(ad.startedAt)} · {ad.country}</small></span></div>
          {!compact && <p>{ad.headline}</p>}
        </div>
        <button className={`favorite-button ${ad.isFavorite ? "saved" : ""}`} aria-label="Сохранить объявление" onClick={(event) => { event.stopPropagation(); onFavorite(ad); }}><Bookmark size={17} fill={ad.isFavorite ? "currentColor" : "none"} /></button>
      </article>
    );
  }

  return (
    <article className="ad-card meta-card" onClick={() => onOpen(ad)}>
      <header className="card-header">
        <div className="card-advertiser">{avatar}<span><strong>{ad.advertiser}</strong><small>{formatDate(ad.startedAt)} · {ad.daysActive} дней</small></span></div>
        <div className="card-header-actions"><span className="country-code">{ad.country}</span><button className={ad.isFavorite ? "saved" : ""} aria-label="Сохранить объявление" onClick={(event) => { event.stopPropagation(); onFavorite(ad); }}><Bookmark size={17} fill={ad.isFavorite ? "currentColor" : "none"} /></button></div>
      </header>
      {media}
      <div className="card-content">
        <div className="platforms">{ad.platforms.map((platform) => <span key={platform}>{platform}</span>)}</div>
        {ad.appUrl && <small className="display-url">{ad.appUrl}</small>}
        <h3>{ad.headline}</h3>
        {!compact && <p>{ad.body}</p>}
        <div className="card-cta"><span>{ad.cta}</span><ExternalLink size={15} /></div>
      </div>
    </article>
  );
}
