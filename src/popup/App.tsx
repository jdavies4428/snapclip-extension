import { useState } from 'react';

export default function App() {
  const [status, setStatus] = useState('');
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

      const response = await chrome.runtime.sendMessage({
        type: 'start-clip-workflow',
        clipMode,
        tabId: tab.id,
        windowId: tab.windowId,
      });
      if (!response?.ok) {
        throw new Error(response?.error || 'Failed to start clipping.');
      }
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
        <div className="header-row">
          <h1>Clip fast</h1>
          <button
            aria-label="Close popup"
            className="ghost-button close-button"
            onClick={() => window.close()}
            type="button"
          >
            X
          </button>
        </div>
        <p className="lede">Shortcuts are the fastest path. The popup is just a quick launcher.</p>
      </header>

      <section className="mode-list" aria-label="Clip actions">
        <button disabled={isLoading} onClick={() => handleStartClip('visible')} type="button">
          {isLoading ? 'Working...' : 'Clip visible tab'}
        </button>
        <button className="secondary" disabled={isLoading} onClick={() => handleStartClip('region')} type="button">
          Clip selected area
        </button>
      </section>

      <section className="shortcut-list" aria-label="Keyboard shortcuts">
        <div className="shortcut-chip">
          <span>Area</span>
          <kbd>Option/Alt + Shift + S</kbd>
        </div>
        <div className="shortcut-chip">
          <span>Visible</span>
          <kbd>Option/Alt + Shift + D</kbd>
        </div>
      </section>

      <div className="footer-row">
        <button className="ghost-button" onClick={handleOpenPanel} type="button">
          Open side panel
        </button>
        <button className="ghost-button" onClick={() => window.close()} type="button">
          Close
        </button>
      </div>

      {status ? <p className="status">{status}</p> : null}
      <p className="mode-description">You can change shortcuts in `chrome://extensions/shortcuts`.</p>
    </main>
  );
}
