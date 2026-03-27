export function ensureSupportedWindow(windowId?: number): number {
  if (typeof windowId !== 'number') {
    throw new Error('No active browser window was found.');
  }

  return windowId;
}

const UNSUPPORTED_PROTOCOLS = ['chrome:', 'chrome-extension:', 'edge:', 'about:', 'file:'] as const;

function normalizeUrl(url?: string): URL | null {
  if (!url) {
    return null;
  }

  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function getOriginPermissionPattern(url: string): string | null {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) {
    return null;
  }

  if (normalizedUrl.protocol !== 'http:' && normalizedUrl.protocol !== 'https:') {
    return null;
  }

  return `${normalizedUrl.protocol}//${normalizedUrl.hostname}/*`;
}

export function getUrlHostLabel(url?: string): string {
  const normalizedUrl = normalizeUrl(url);
  return normalizedUrl?.hostname.replace(/^www\./, '') || 'this site';
}

export function isHostAccessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return (
    message.includes('Extension manifest must request permission to access this host') ||
    message.includes('Cannot access contents of url') ||
    message.includes('Missing host permission for the tab')
  );
}

export async function requestTabHostAccess(
  tab: chrome.tabs.Tab & { id: number },
  options?: { interactive?: boolean },
): Promise<'granted' | 'requested' | 'denied' | 'unsupported'> {
  const originPattern = getOriginPermissionPattern(tab.url || '');
  if (!originPattern) {
    return 'unsupported';
  }

  const hasAccess = await chrome.permissions.contains({ origins: [originPattern] });
  if (hasAccess) {
    return 'granted';
  }

  if (options?.interactive) {
    try {
      const granted = await chrome.permissions.request({ origins: [originPattern] });
      if (granted) {
        return 'granted';
      }
    } catch {
      // Fall through to the tab-scoped host access request below.
    }
  }

  if (typeof chrome.permissions.addHostAccessRequest === 'function') {
    try {
      await chrome.permissions.addHostAccessRequest({
        tabId: tab.id,
        pattern: originPattern,
      });
      return 'requested';
    } catch {
      // Ignore and fall through to denied.
    }
  }

  return 'denied';
}

export function assertSupportedTab(tab?: chrome.tabs.Tab): asserts tab is chrome.tabs.Tab & { id: number } {
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('No active tab was found.');
  }

  if (tab.discarded) {
    throw new Error('The current tab is discarded. Reload it and try again.');
  }

  if (tab.status === 'unloaded') {
    throw new Error('The current tab is not fully available yet. Try again once it finishes loading.');
  }

  const normalizedUrl = normalizeUrl(tab.url);
  if (!normalizedUrl) {
    throw new Error('LLM Clip could not read the current tab URL.');
  }

  if (UNSUPPORTED_PROTOCOLS.includes(normalizedUrl.protocol as (typeof UNSUPPORTED_PROTOCOLS)[number])) {
    throw new Error('LLM Clip only works on normal web pages, not browser or extension pages.');
  }

  if (normalizedUrl.hostname === 'chromewebstore.google.com' || normalizedUrl.hostname === 'chrome.google.com') {
    throw new Error('LLM Clip cannot clip the Chrome Web Store.');
  }

  if (normalizedUrl.pathname.toLowerCase().endsWith('.pdf')) {
    throw new Error('LLM Clip does not support PDF tabs yet.');
  }
}

export async function getActiveTab(): Promise<chrome.tabs.Tab & { id: number }> {
  const [lastFocusedTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const [currentWindowTab] = lastFocusedTab ? [null] : await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = lastFocusedTab ?? currentWindowTab;

  if (!tab || typeof tab.id !== 'number') {
    throw new Error('No active tab was found.');
  }

  return tab as chrome.tabs.Tab & { id: number };
}

export async function getSupportedActiveTab(): Promise<chrome.tabs.Tab & { id: number }> {
  const tab = await getActiveTab();
  assertSupportedTab(tab);
  return tab;
}

export async function getTabById(tabId: number): Promise<chrome.tabs.Tab & { id: number }> {
  const tab = await chrome.tabs.get(tabId);
  if (typeof tab.id !== 'number') {
    throw new Error('The selected tab is no longer available.');
  }

  return tab as chrome.tabs.Tab & { id: number };
}

export async function getSupportedTabById(tabId: number): Promise<chrome.tabs.Tab & { id: number }> {
  const tab = await getTabById(tabId);
  assertSupportedTab(tab);
  return tab;
}
