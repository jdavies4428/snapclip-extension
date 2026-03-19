import { useEffect, useState } from 'react';
import { getClipAssetBlob } from '../../shared/storage/blob-store';

export function useClipAssetUrl(assetId: string | null) {
  const [assetUrl, setAssetUrl] = useState<string | null>(null);

  useEffect(() => {
    let revokedUrl: string | null = null;
    let cancelled = false;

    async function loadAsset() {
      if (!assetId) {
        setAssetUrl(null);
        return;
      }

      const blob = await getClipAssetBlob(assetId);
      if (cancelled || !blob) {
        setAssetUrl(null);
        return;
      }

      const nextUrl = URL.createObjectURL(blob);
      revokedUrl = nextUrl;
      setAssetUrl(nextUrl);
    }

    void loadAsset();

    return () => {
      cancelled = true;
      if (revokedUrl) {
        URL.revokeObjectURL(revokedUrl);
      }
    };
  }, [assetId]);

  return assetUrl;
}
