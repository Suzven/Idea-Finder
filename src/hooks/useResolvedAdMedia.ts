import { useEffect, useMemo, useState } from "react";
import { fetchAdMedia, type ResolvedAdMedia } from "../api";
import type { AdCreative } from "../shared/types";

export function useResolvedAdMedia(ad: AdCreative): {
  ad: AdCreative;
  loading: boolean;
  error: boolean;
} {
  const [media, setMedia] = useState<ResolvedAdMedia>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setMedia(undefined);
    setError(false);
    if (ad.mediaUrl || !ad.mediaInfoUrl) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void fetchAdMedia(ad.mediaInfoUrl)
      .then((result) => { if (!controller.signal.aborted) setMedia(result); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [ad.id, ad.mediaInfoUrl, ad.mediaUrl]);

  const resolvedAd = useMemo(() => media ? { ...ad, ...media } : ad, [ad, media]);
  return { ad: resolvedAd, loading, error };
}
