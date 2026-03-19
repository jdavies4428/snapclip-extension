import { useState } from 'react';
import type { SnapClipMessageResponse } from '../shared/messaging/messages';

export default function App() {
  const [status, setStatus] = useState('Choose whether to clip the full visible tab or a selected area.');
  const [isLoading, setIsLoading] = useState(false);
  function isLaunchablePage(url?: string): boolean {
    if (!url) {
      return false;
    }

    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  async function resolveCaptureTargetTab(): Promise<(chrome.tabs.Tab & { id: number }) | null> {
    const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
    const preferredTab =
      tabs.find((tab) => tab.active && typeof tab.id === 'number' && isLaunchablePage(tab.url)) ||
      tabs.find((tab) => typeof tab.id === 'number' && isLaunchablePage(tab.url));

    return preferredTab && typeof preferredTab.id === 'number'
      ? (preferredTab as chrome.tabs.Tab & { id: number })
      : null;
  }

  async function openPanelForCurrentWindow() {
    const tab = await resolveCaptureTargetTab();
    if (typeof tab?.windowId !== 'number') {
      throw new Error('No active browser window was found.');
    }

    await chrome.sidePanel.open({ windowId: tab.windowId });
  }

  async function handleStartClip(clipMode: 'visible' | 'region') {
    setIsLoading(true);
    setStatus(clipMode === 'visible' ? 'Snapping the visible tab...' : 'Preparing region clip...');

    try {
      const tab = await resolveCaptureTargetTab();
      if (typeof tab?.id !== 'number' || typeof tab.windowId !== 'number') {
        throw new Error('No supported page tab was found.');
      }

      if (clipMode === 'visible') {
        await openPanelForCurrentWindow();
      }
      void chrome.runtime.sendMessage({
        type: 'start-clip-workflow',
        clipMode,
        tabId: tab.id,
        windowId: tab.windowId,
      });
      window.close();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to start clipping.');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleOpenPanel() {
    try {
      await openPanelForCurrentWindow();
      setStatus('Side panel opened.');
      window.close();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to open the side panel.');
    }
  }

  return (
    <main className="popup-shell">
      <header className="popup-header">
        <p className="eyebrow">LLM Clip</p>
        <h1>Clip the current tab</h1>
        <p className="lede">Full-tab snap happens instantly. Region mode opens the picker on the current page.</p>
      </header>

      <section className="mode-list" aria-label="Clip actions">
        <button disabled={isLoading} onClick={() => handleStartClip('visible')} type="button">
          {isLoading ? 'Working...' : 'Clip visible tab'}
        </button>
        <button className="secondary" disabled={isLoading} onClick={() => handleStartClip('region')} type="button">
          Clip selected area
        </button>
      </section>

      <button className="secondary" onClick={handleOpenPanel} type="button">
        Open side panel
      </button>

      <p className="status">{status}</p>
      <p className="mode-description">Chrome can override shortcuts in `chrome://extensions/shortcuts`. Browser pages, extension pages, Chrome Web Store, and PDFs are blocked.</p>
    </main>
  );
}
