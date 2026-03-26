import { useEffect, useState } from 'react';

type ShortcutCommandName = 'start-region-clip' | 'start-visible-clip' | 'open-last-clip-editor';

const FALLBACK_SHORTCUT_LABELS: Record<ShortcutCommandName, string> = {
  'start-region-clip': 'Option/Alt + Shift + S',
  'start-visible-clip': 'Option/Alt + Shift + D',
  'open-last-clip-editor': 'Option/Alt + Shift + E',
};

export default function App() {
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [shortcutLabels, setShortcutLabels] = useState<Record<ShortcutCommandName, string>>(FALLBACK_SHORTCUT_LABELS);

  useEffect(() => {
    let cancelled = false;

    async function loadShortcutLabels() {
      try {
        const commands = await chrome.commands.getAll();
        if (cancelled) {
          return;
        }

        const nextLabels = { ...FALLBACK_SHORTCUT_LABELS };
        for (const command of commands) {
          if (!command.name || !(command.name in nextLabels)) {
            continue;
          }

          const name = command.name as ShortcutCommandName;
          nextLabels[name] = command.shortcut?.trim() || 'Set in Chrome shortcuts';
        }

        setShortcutLabels(nextLabels);
      } catch (error) {
        console.warn('Failed to load Chrome shortcut labels.', error);
      }
    }

    void loadShortcutLabels();

    return () => {
      cancelled = true;
    };
  }, []);

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
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">
            LC
          </div>
          <div className="brand-copy">
            <p className="eyebrow">LLM Clip</p>
            <p className="status-badge">Local-first capture</p>
          </div>
          <button
            aria-label="Close popup"
            className="ghost-button close-button"
            onClick={() => window.close()}
            type="button"
          >
            X
          </button>
        </div>
        <div className="hero-copy">
          <h1>Clip the tab, hand off the evidence.</h1>
          <p className="lede">
            The popup is a fast launcher. The shortcut stays primary, the bundle stays local, and the next action is
            always obvious.
          </p>
        </div>
      </header>

      <section className="action-stack" aria-label="Clip actions">
        <button
          className="action-card action-card-primary"
          disabled={isLoading}
          onClick={() => handleStartClip('visible')}
          type="button"
        >
          <span className="action-kicker">Fast path</span>
          <span className="action-title">{isLoading ? 'Working...' : 'Clip visible tab'}</span>
          <span className="action-copy">Capture the current viewport and open the annotation workspace.</span>
        </button>
        <button
          className="action-card"
          disabled={isLoading}
          onClick={() => handleStartClip('region')}
          type="button"
        >
          <span className="action-kicker">Targeted path</span>
          <span className="action-title">Clip selected area</span>
          <span className="action-copy">Drag a region on the page when you only need the broken slice.</span>
        </button>
      </section>

      <section className="shortcut-panel" aria-label="Keyboard shortcuts">
        <div className="panel-head">
          <p className="eyebrow">Shortcuts</p>
          <p className="panel-hint">Use these when you want the quick clipboard lane instead of the full editor.</p>
        </div>
        <div className="shortcut-list">
          <div className="shortcut-chip">
            <span>Area</span>
            <kbd>{shortcutLabels['start-region-clip']}</kbd>
          </div>
          <div className="shortcut-chip">
            <span>Visible</span>
            <kbd>{shortcutLabels['start-visible-clip']}</kbd>
          </div>
          <div
            className={`shortcut-chip ${
              shortcutLabels['open-last-clip-editor'] === 'Set in Chrome shortcuts' ? 'shortcut-chip-warning' : ''
            }`}
          >
            <span>Edit latest</span>
            <kbd>{shortcutLabels['open-last-clip-editor']}</kbd>
          </div>
        </div>
      </section>

      <section className="utility-row" aria-label="Secondary actions">
        <button className="ghost-button utility-button" onClick={handleOpenPanel} type="button">
          Open side panel
        </button>
        <button className="ghost-button utility-button" onClick={() => window.close()} type="button">
          Dismiss
        </button>
      </section>

      <footer className="footer-stack">
        {status ? <p className="status">{status}</p> : null}
        <p className="mode-description">Change shortcuts in `chrome://extensions/shortcuts`.</p>
      </footer>
    </main>
  );
}
