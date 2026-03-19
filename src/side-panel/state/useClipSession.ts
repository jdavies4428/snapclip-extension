import { useEffect, useState } from 'react';
import { STORAGE_KEYS, isClipStorageKey } from '../../shared/snapshot/storage';
import type { ClipSession } from '../../shared/types/session';
import { clipSessionSchema } from '../../shared/types/session';

export function useClipSession() {
  const [session, setSession] = useState<ClipSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      const result = await chrome.runtime.sendMessage({
        type: 'get-clip-session',
      });
      if (!cancelled) {
        setSession(result.ok && result.session ? clipSessionSchema.parse(result.session) : null);
        setIsLoading(false);
      }
    }

    void loadSession();

    const handleChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local') {
        return;
      }

      const didSessionChange = Object.keys(changes).some(
        (key) => key === STORAGE_KEYS.clipSessionIndex || isClipStorageKey(key),
      );
      if (!didSessionChange) {
        return;
      }

      void loadSession();
    };

    chrome.storage.onChanged.addListener(handleChange);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(handleChange);
    };
  }, []);

  return { session, isLoading };
}
