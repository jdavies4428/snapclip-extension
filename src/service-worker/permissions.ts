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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
