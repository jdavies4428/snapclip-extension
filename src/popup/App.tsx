import { useEffect, useState } from 'react';

const BRIDGE_HEALTH_URL = 'http://127.0.0.1:4311/health';
const COMPANION_DOWNLOAD_URL = 'https://github.com/jdavies4428/snapclip-extension/releases/latest/download/SnapClipBridge.pkg';

type BridgeStatus = 'checking' | 'connected' | 'missing';

type ShortcutCommandName =
  | 'start-region-clip'
  | 'start-visible-clip'
  | 'open-last-clip-editor'
  | 'open-side-panel';

const FALLBACK_SHORTCUT_LABELS: Record<ShortcutCommandName, string> = {
  'start-region-clip': 'Option/Alt + Shift + S',
  'start-visible-clip': 'Option/Alt + Shift + D',
  'open-last-clip-editor': 'Option/Alt + Shift + E',
  'open-side-panel': 'Option/Alt + Shift + P',
};

export default function App() {
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [shortcutLabels, setShortcutLabels] = useState<Record<ShortcutCommandName, string>>(FALLBACK_SHORTCUT_LABELS);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>('checking');

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

    async function checkBridge() {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(BRIDGE_HEALTH_URL, { signal: controller.signal });
        clearTimeout(timeout);
        if (!cancelled) setBridgeStatus(res.ok ? 'connected' : 'missing');
      } catch {
        if (!cancelled) setBridgeStatus('missing');
      }
    }

    void checkBridge();

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
          <div className="brand-dot" aria-hidden="true" />
          <span className="brand-name">SnapClip</span>
        </div>
        {bridgeStatus === 'connected' && (
          <span className="bridge-chip bridge-chip-connected" aria-label="Bridge connected">
            ● bridge
          </span>
        )}
        {bridgeStatus === 'checking' && (
          <span className="bridge-chip bridge-chip-checking" aria-label="Checking bridge">
            ○ checking
          </span>
        )}
      </header>

      {bridgeStatus === 'missing' && (
        <section className="companion-banner" aria-label="Companion required">
          <p className="companion-banner-title">Companion needed for AI handoff</p>
          <p className="companion-banner-body">
            Capture and annotate still work without it.
          </p>
          <a
            className="companion-download-link"
            href={COMPANION_DOWNLOAD_URL}
            rel="noreferrer"
            target="_blank"
          >
            Download companion →
          </a>
        </section>
      )}

      <div className="popup-body">
        <section aria-label="Clip actions">
          <div className="action-stack">
            <button
              className="action-btn action-btn-primary"
              disabled={isLoading}
              onClick={() => handleStartClip('visible')}
              type="button"
            >
              <span className="action-btn-label">
                {isLoading ? 'Working...' : 'Capture Tab'}
              </span>
              <span className="action-btn-kbd">{shortcutLabels['start-visible-clip']}</span>
            </button>
            <button
              className="action-btn action-btn-secondary"
              disabled={isLoading}
              onClick={() => handleStartClip('region')}
              type="button"
            >
              <span className="action-btn-label">Clip Region</span>
              <span className="action-btn-kbd">{shortcutLabels['start-region-clip']}</span>
            </button>
          </div>
        </section>

        <div className="section-divider" />

        <section className="shortcut-panel" aria-label="Keyboard shortcuts">
          <p className="shortcut-panel-label">Shortcuts</p>
          <div className="shortcut-list">
            <div className="shortcut-chip">
              <span>Clip region</span>
              <kbd>{shortcutLabels['start-region-clip']}</kbd>
            </div>
            <div className="shortcut-chip">
              <span>Clip tab</span>
              <kbd>{shortcutLabels['start-visible-clip']}</kbd>
            </div>
            <div
              className={`shortcut-chip${
                shortcutLabels['open-last-clip-editor'] === 'Set in Chrome shortcuts'
                  ? ' shortcut-chip-warning'
                  : ''
              }`}
            >
              <span>Edit latest</span>
              <kbd>{shortcutLabels['open-last-clip-editor']}</kbd>
            </div>
            <div
              className={`shortcut-chip${
                shortcutLabels['open-side-panel'] === 'Set in Chrome shortcuts'
                  ? ' shortcut-chip-warning'
                  : ''
              }`}
            >
              <span>Open panel</span>
              <kbd>{shortcutLabels['open-side-panel']}</kbd>
            </div>
          </div>
        </section>

        <div className="section-divider" />

        <section className="utility-row" aria-label="Secondary actions">
          <button className="action-btn action-btn-ghost" onClick={handleOpenPanel} type="button">
            Open panel
          </button>
          <button className="action-btn action-btn-ghost" onClick={() => window.close()} type="button">
            Dismiss
          </button>
        </section>
      </div>

      <footer className="footer-stack">
        {status ? <p className="status">{status}</p> : null}
        <p className="mode-description">Change shortcuts in chrome://extensions/shortcuts</p>
      </footer>
    </main>
  );
}
