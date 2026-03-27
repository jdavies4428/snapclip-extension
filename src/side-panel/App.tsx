import { useMemo, useState } from 'react';
import type { BridgeSession, HandoffPackageMode } from '../shared/bridge/client';
import type { SnapClipMessageResponse } from '../shared/messaging/messages';
import type { ClipRecord } from '../shared/types/session';
import { useClipAssetUrl } from './state/useClipAssetUrl';
import { useClipSession } from './state/useClipSession';
import { useBridgeState } from './state/useBridgeState';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatClipLabel(clip: ClipRecord, index: number): string {
  const fallback = `Clip ${index + 1}`;
  const title = clip.title.trim() || fallback;
  return title.length > 48 ? `${title.slice(0, 47)}…` : title;
}

function formatClipMeta(clip: ClipRecord): string {
  const timestamp = new Date(clip.createdAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${clip.clipMode} • ${timestamp}`;
}

function formatSessionLabel(session: BridgeSession): string {
  return session.target === 'codex' ? `${session.label} · Codex` : `${session.label} · Claude`;
}

function getBulkPackageConfig(packageMode: HandoffPackageMode) {
  if (packageMode === 'image') {
    return {
      actionLabel: 'Send all images',
      modalTitle: 'Choose a session for all images',
      modalCopy: 'Send all saved clip images in one ordered bundle. No shared packet files will be attached.',
      evidenceProfile: 'lean' as const,
    };
  }

  return {
    actionLabel: 'Send all + packet',
    modalTitle: 'Choose a session for all images + packet',
    modalCopy: 'Send all saved clip images plus one shared packet of notes, annotations, and local evidence.',
    evidenceProfile: 'balanced' as const,
  };
}

// ─── ClipGalleryTile ──────────────────────────────────────────────────────────

function ClipGalleryTile({
  clip,
  index,
  isExpanded,
  onClick,
  onOpen,
}: {
  clip: ClipRecord;
  index: number;
  isExpanded: boolean;
  onClick: (clipId: string) => void;
  onOpen: (clipId: string) => void;
}) {
  const imageUrl = useClipAssetUrl(clip.imageAssetId);
  const hasAnnotations = clip.annotations.length > 0;
  const errorCount = clip.runtimeContext?.summary.errorCount ?? 0;
  const lastHandoffState = clip.lastHandoff?.deliveryState;
  const tileState =
    lastHandoffState === 'delivered' || lastHandoffState === 'bundle_created'
      ? 'sent'
      : hasAnnotations || clip.note.trim().length > 0
        ? 'annotated'
        : 'idle';

  return (
    <button
      aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${clip.title || `clip ${index + 1}`}`}
      aria-pressed={isExpanded}
      className={`clip-tile${isExpanded ? ' is-expanded' : ''}`}
      data-state={tileState}
      onClick={() => onClick(clip.id)}
      onDoubleClick={() => onOpen(clip.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick(clip.id);
        }
      }}
      title="Click to expand. Double-click to reopen in the page editor."
      type="button"
    >
      {imageUrl ? (
        <img
          alt={clip.title || `Saved clip ${index + 1}`}
          className="clip-tile-image"
          src={imageUrl}
        />
      ) : (
        <div className="clip-tile-image-placeholder">Loading…</div>
      )}

      {hasAnnotations && (
        <span aria-hidden="true" className="clip-tile-badge">
          ✎
        </span>
      )}

      <div className="clip-tile-meta">
        <span className="clip-tile-title">{formatClipLabel(clip, index)}</span>
        <span className="clip-tile-errors">
          {errorCount > 0 ? `${errorCount} err` : formatClipMeta(clip)}
        </span>
      </div>
    </button>
  );
}

// ─── ClipDetailPanel ─────────────────────────────────────────────────────────

function ClipDetailPanel({
  clip,
  onClose,
  onOpen,
}: {
  clip: ClipRecord;
  onClose: () => void;
  onOpen: (clipId: string) => void;
}) {
  const imageUrl = useClipAssetUrl(clip.imageAssetId);
  const summary = clip.runtimeContext?.summary;
  const errorCount = summary?.errorCount ?? 0;
  const warningCount = summary?.warningCount ?? 0;
  const networkCount = summary?.networkRequestCount ?? 0;
  const pageUrl = clip.page.url;

  async function handleCopyImage() {
    if (!imageUrl) return;
    try {
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    } catch {
      // Silently ignore — clipboard API may not be available in all contexts.
    }
  }

  return (
    <div className="clip-detail">
      {imageUrl ? (
        <img
          alt={clip.title || 'Clip screenshot'}
          className="clip-detail-image"
          src={imageUrl}
        />
      ) : (
        <div className="clip-tile-image-placeholder" style={{ maxHeight: 240 }}>
          Loading…
        </div>
      )}

      {/* Context strip */}
      <div className="clip-detail-context" role="list">
        {errorCount > 0 && (
          <span className="clip-context-chip chip-error" role="listitem">
            {errorCount} error{errorCount !== 1 ? 's' : ''}
          </span>
        )}
        {warningCount > 0 && (
          <span className="clip-context-chip chip-amber" role="listitem">
            {warningCount} warn{warningCount !== 1 ? 's' : ''}
          </span>
        )}
        {networkCount > 0 && (
          <span className="clip-context-chip" role="listitem">
            {networkCount} req
          </span>
        )}
        {pageUrl && (
          <span
            className="clip-context-chip"
            role="listitem"
            style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}
            title={pageUrl}
          >
            {pageUrl}
          </span>
        )}
        {errorCount === 0 && warningCount === 0 && networkCount === 0 && !pageUrl && (
          <span className="clip-context-chip">No runtime context</span>
        )}
      </div>

      {/* Prompt textarea */}
      <div className="clip-detail-prompt">
        <label className="clip-detail-prompt-label" htmlFor={`clip-note-${clip.id}`}>
          Prompt for this clip
        </label>
        <textarea
          className="clip-detail-textarea"
          defaultValue={clip.note}
          id={`clip-note-${clip.id}`}
          placeholder="What's wrong here? What should the model do?"
          rows={3}
        />
      </div>

      {/* Action row */}
      <div className="clip-detail-actions">
        <button
          className="btn btn-ghost"
          onClick={() => void handleCopyImage()}
          title="Copy image to clipboard"
          type="button"
        >
          Copy image
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => onOpen(clip.id)}
          type="button"
        >
          Export
        </button>
        <button
          className="btn btn-primary"
          onClick={onClose}
          type="button"
        >
          Done ✓
        </button>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const { session, isLoading } = useClipSession();
  const [status, setStatus] = useState('');
  const [pendingPackageMode, setPendingPackageMode] = useState<HandoffPackageMode | null>(null);
  const [isSendingBulk, setIsSendingBulk] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [expandedClipId, setExpandedClipId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'clips' | 'session' | 'bridge' | 'export'>('clips');

  const bridge = useBridgeState({
    enabled: pendingPackageMode !== null || activeTab === 'bridge',
    reloadKey: pendingPackageMode ?? (activeTab === 'bridge' ? 'bridge-tab' : 'idle'),
  });

  const clips = useMemo(
    () =>
      [...(session?.clips ?? [])].sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
      ),
    [session?.clips],
  );
  const preferredClipId = session?.activeClipId || clips[0]?.id || '';
  const bulkPackageConfig = pendingPackageMode ? getBulkPackageConfig(pendingPackageMode) : null;
  const expandedClip = expandedClipId ? clips.find((c) => c.id === expandedClipId) ?? null : null;

  // ── Tab click collapses detail when switching away ─────────────────────────
  function handleTabChange(tab: typeof activeTab) {
    setActiveTab(tab);
    if (tab !== 'clips') {
      setExpandedClipId(null);
    }
  }

  // ── Capture tab resolving ──────────────────────────────────────────────────
  async function resolveCaptureTargetTab(): Promise<(chrome.tabs.Tab & { id: number }) | null> {
    const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
    const preferredTab =
      tabs.find((tab) => tab.active && typeof tab.id === 'number' && (tab.url?.startsWith('http:') || tab.url?.startsWith('https:'))) ||
      tabs.find((tab) => typeof tab.id === 'number' && (tab.url?.startsWith('http:') || tab.url?.startsWith('https:')));

    return preferredTab && typeof preferredTab.id === 'number'
      ? (preferredTab as chrome.tabs.Tab & { id: number })
      : null;
  }

  async function handleStartClip(clipMode: 'visible' | 'region') {
    setIsCapturing(true);
    setStatus(clipMode === 'visible' ? 'Clipping the current tab…' : 'Preparing the selector…');

    try {
      const tab = await resolveCaptureTargetTab();
      if (typeof tab?.id !== 'number' || typeof tab.windowId !== 'number') {
        throw new Error('No supported page tab was found.');
      }

      const response = (await chrome.runtime.sendMessage({
        type: 'start-clip-workflow',
        clipMode,
        tabId: tab.id,
        windowId: tab.windowId,
      })) as SnapClipMessageResponse;

      if (!response?.ok) {
        throw new Error(response?.error || 'Failed to start clipping.');
      }

      setStatus(clipMode === 'visible' ? 'Captured the current tab.' : 'Selector launched on the current page.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to start clipping.');
    } finally {
      setIsCapturing(false);
    }
  }

  async function openClipEditor(clipId: string) {
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'open-clip-editor',
        clipId,
      })) as SnapClipMessageResponse;

      setStatus(response.ok ? 'Opened clip editor.' : response.error);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to open the clip editor.');
    }
  }

  async function clearAllClips() {
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'clear-clip-session',
      })) as SnapClipMessageResponse;

      setStatus(response.ok ? 'Cleared all saved images.' : response.error);
      setExpandedClipId(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to clear saved images.');
    }
  }

  async function sendAllToSession(targetSession: BridgeSession) {
    if (!pendingPackageMode || !preferredClipId || isSendingBulk) {
      return;
    }

    const config = getBulkPackageConfig(pendingPackageMode);
    setIsSendingBulk(true);
    setStatus(`Sending ${config.actionLabel.toLowerCase()} to ${targetSession.label}...`);

    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'send-bridge-session',
        target: targetSession.target,
        workspaceId: targetSession.workspaceId,
        sessionId: targetSession.id,
        clipId: preferredClipId,
        packageMode: pendingPackageMode,
        scope: 'session',
        evidenceProfile: config.evidenceProfile,
        intent: 'fix',
      })) as SnapClipMessageResponse;

      if (!response.ok || !response.task) {
        throw new Error(response.ok ? 'The bulk handoff did not return a task.' : response.error);
      }

      const targetLabel = formatSessionLabel(targetSession);
      const deliveryState = response.task.delivery.state;
      setStatus(
        deliveryState === 'failed_after_bundle_creation'
          ? `Send failed after bundle creation for ${targetLabel}.`
          : `Sent ${config.actionLabel.toLowerCase()} to ${targetLabel}.`,
      );
      setPendingPackageMode(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to send the saved clips.');
    } finally {
      setIsSendingBulk(false);
    }
  }

  // ── Loading state ──────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <main className="panel-shell">
        <header className="panel-header">
          <div className="panel-header-brand">
            <span className="panel-header-dot" />
            <span className="panel-header-wordmark">SnapClip</span>
          </div>
          <div className="panel-header-center" />
          <div className="panel-header-right" />
        </header>
        <div className="panel-content">
          <div className="panel-empty">
            <p className="panel-empty-copy">Loading saved clips…</p>
          </div>
        </div>
      </main>
    );
  }

  // ── Empty state ────────────────────────────────────────────────────────────
  if (!clips.length) {
    return (
      <main className="panel-shell">
        <header className="panel-header">
          <div className="panel-header-brand">
            <span className="panel-header-dot" />
            <span className="panel-header-wordmark">SnapClip</span>
          </div>
          <div className="panel-header-center" />
          <div className="panel-header-right" />
        </header>

        <div className="panel-content">
          <div className="capture-row">
            <button
              className="btn btn-primary"
              disabled={isCapturing}
              onClick={() => void handleStartClip('visible')}
              type="button"
            >
              {isCapturing ? 'Working…' : 'Clip tab'}
            </button>
            <button
              className="btn btn-secondary"
              disabled={isCapturing}
              onClick={() => void handleStartClip('region')}
              type="button"
            >
              Use selector
            </button>
          </div>

          <div className="panel-empty">
            <p className="panel-empty-heading">No clips yet</p>
            <p className="panel-empty-copy">
              Saved clips appear here. Click a thumbnail to expand it or double-click to reopen in the page editor.
            </p>
          </div>
        </div>

        <p aria-live="polite" className="sr-only" role="status">
          {status}
        </p>

        <nav aria-label="Panel navigation" className="dock-nav">
          <button
            className={`dock-nav-btn${activeTab === 'clips' ? ' is-active' : ''}`}
            onClick={() => handleTabChange('clips')}
            type="button"
          >
            <span aria-hidden="true" className="dock-nav-icon">&#128444;</span>
            Clips
          </button>
          <button
            className={`dock-nav-btn${activeTab === 'session' ? ' is-active' : ''}`}
            onClick={() => handleTabChange('session')}
            type="button"
          >
            <span aria-hidden="true" className="dock-nav-icon">&#128196;</span>
            Session
          </button>
          <button
            className={`dock-nav-btn${activeTab === 'bridge' ? ' is-active' : ''}`}
            onClick={() => handleTabChange('bridge')}
            type="button"
          >
            <span aria-hidden="true" className="dock-nav-icon">&#128279;</span>
            Bridge
          </button>
          <button
            className={`dock-nav-btn${activeTab === 'export' ? ' is-active' : ''}`}
            onClick={() => handleTabChange('export')}
            type="button"
          >
            <span aria-hidden="true" className="dock-nav-icon">&#128228;</span>
            Export
          </button>
        </nav>
      </main>
    );
  }

  // ── Main panel ─────────────────────────────────────────────────────────────
  return (
    <main className="panel-shell">
      {/* Sticky header */}
      <header className="panel-header">
        <div className="panel-header-brand">
          <span className="panel-header-dot" />
          <span className="panel-header-wordmark">SnapClip</span>
        </div>

        <div className="panel-header-center">
          {/* Bridge status pill — shown when bridge connection is healthy */}
          {bridge.bridgeHealth?.ok === true && (
            <span className="bridge-status-pill">
              <span className="bridge-status-pill-dot" />
              connected
            </span>
          )}
        </div>

        <div className="panel-header-right">
          {clips.length > 0 && (
            <button
              className="send-all-pill"
              disabled={isCapturing || isSendingBulk}
              onClick={() => setPendingPackageMode('packet')}
              type="button"
            >
              Send All ({clips.length})
            </button>
          )}
        </div>
      </header>

      {/* Scrollable content */}
      <div className="panel-content">
        {activeTab === 'clips' && (
          <>
            {/* Capture row */}
            <div className="capture-row">
              <button
                className="btn btn-primary"
                disabled={isCapturing}
                onClick={() => void handleStartClip('visible')}
                type="button"
              >
                {isCapturing ? 'Working…' : 'Clip tab'}
              </button>
              <button
                className="btn btn-secondary"
                disabled={isCapturing}
                onClick={() => void handleStartClip('region')}
                type="button"
              >
                Use selector
              </button>
              <button
                className="btn btn-danger"
                disabled={isCapturing}
                onClick={() => void clearAllClips()}
                title="Delete all saved clips"
                type="button"
              >
                Clear
              </button>
            </div>

            {/* Camera roll grid */}
            <section aria-label="Saved clips" className="clip-grid">
              {clips.map((clip, index) => (
                <ClipGalleryTile
                  clip={clip}
                  index={index}
                  isExpanded={expandedClipId === clip.id}
                  key={clip.id}
                  onClick={(id) => setExpandedClipId(expandedClipId === id ? null : id)}
                  onOpen={openClipEditor}
                />
              ))}
            </section>

            {/* Inline expanded detail — rendered below the grid */}
            {expandedClip && (
              <ClipDetailPanel
                clip={expandedClip}
                onClose={() => setExpandedClipId(null)}
                onOpen={openClipEditor}
              />
            )}
          </>
        )}

        {activeTab === 'session' && (
          <div>
            <div className="section-header">
              <span className="section-title">Session</span>
              {clips.length > 0 && (
                <span className="bridge-status-pill">{clips.length} clip{clips.length !== 1 ? 's' : ''}</span>
              )}
            </div>
            {clips.length === 0 ? (
              <div className="panel-empty">
                <p className="panel-empty-copy">No clips captured yet. Use the capture buttons above.</p>
              </div>
            ) : (
              <div className="session-clip-list">
                {clips.map((clip) => (
                  <div key={clip.id} className="session-clip-row">
                    <div className="session-clip-meta">
                      <span className="session-clip-title">{clip.title || 'Untitled clip'}</span>
                      <span className="session-clip-time">{new Date(clip.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <button
                      className="btn btn-ghost"
                      onClick={() => openClipEditor(clip.id)}
                      type="button"
                    >
                      Edit
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'bridge' && (
          <div>
            <div className="section-header">
              <span className="section-title">Bridge</span>
              {bridge.bridgeHealth && (
                <span className="bridge-status-pill bridge-status-pill--connected">● connected</span>
              )}
            </div>
            {bridge.isBridgeLoading ? (
              <div className="panel-empty"><p className="panel-empty-copy">Connecting to bridge…</p></div>
            ) : bridge.bridgeError ? (
              <div className="panel-empty"><p className="panel-empty-copy">{bridge.bridgeError}</p></div>
            ) : bridge.bridgeHealth ? (
              <div className="bridge-info">
                <div className="bridge-info-row">
                  <span className="bridge-info-label">Host</span>
                  <span className="bridge-info-value">{bridge.bridgeHealth.companion.host}:{bridge.bridgeHealth.companion.port}</span>
                </div>
                <div className="bridge-info-row">
                  <span className="bridge-info-label">Version</span>
                  <span className="bridge-info-value">{bridge.bridgeHealth.companion.version}</span>
                </div>
                <div className="bridge-info-row">
                  <span className="bridge-info-label">Claude CLI</span>
                  <span className="bridge-info-value">{bridge.bridgeHealth.claude.cliAvailable ? (bridge.bridgeHealth.claude.cliVersion || 'available') : 'not found'}</span>
                </div>
                <div className="bridge-info-row">
                  <span className="bridge-info-label">Hook</span>
                  <span className="bridge-info-value">{bridge.bridgeHealth.claude.hookInstalled ? 'installed' : 'not installed'}</span>
                </div>
                {bridge.bridgeSessions.length > 0 && (
                  <>
                    <div className="section-divider" style={{ margin: '10px 0' }} />
                    <p className="bridge-info-label" style={{ marginBottom: 8 }}>Live sessions</p>
                    {bridge.bridgeSessions.map((s) => (
                      <div key={s.id} className="bridge-session-row">
                        <span className="bridge-session-label">{s.workspaceName || s.label}</span>
                        <span className="bridge-session-target">{s.target}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            ) : (
              <div className="panel-empty">
                <p className="panel-empty-copy">Bridge companion not running. Download it from the popup.</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'export' && (
          <div>
            <div className="section-header">
              <span className="section-title">Export</span>
            </div>
            <div className="panel-empty">
              <p className="panel-empty-copy">
                Export options will appear here.
              </p>
            </div>
            <div className="capture-row" style={{ marginTop: 12 }}>
              <button
                className="btn btn-secondary"
                onClick={() => setPendingPackageMode('image')}
                type="button"
              >
                Send all images
              </button>
              <button
                className="btn btn-primary"
                onClick={() => setPendingPackageMode('packet')}
                type="button"
              >
                Send all + packet
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Send All session picker modal */}
      {pendingPackageMode ? (
        <div aria-modal="true" className="session-picker-backdrop" role="dialog">
          <div className="session-picker-modal">
            <div className="session-picker-header">
              <div>
                <h2>{bulkPackageConfig?.modalTitle}</h2>
                <p>{bulkPackageConfig?.modalCopy}</p>
              </div>
              <button
                aria-label="Close session picker"
                className="btn btn-secondary session-picker-close"
                onClick={() => setPendingPackageMode(null)}
                type="button"
              >
                Close
              </button>
            </div>

            <div className="session-picker-body">
              {bridge.isBridgeLoading || bridge.isSessionLoading ? (
                <p className="session-picker-empty">Loading live agent sessions…</p>
              ) : bridge.bridgeError ? (
                <p className="session-picker-empty">{bridge.bridgeError}</p>
              ) : !bridge.bridgeSessions.length ? (
                <p className="session-picker-empty">No live Claude or Codex sessions are available right now.</p>
              ) : (
                <div className="session-picker-grid">
                  {bridge.bridgeSessions.map((bridgeSession) => (
                    <button
                      className="session-picker-button"
                      disabled={isSendingBulk}
                      key={bridgeSession.id}
                      onClick={() => void sendAllToSession(bridgeSession)}
                      title={bridgeSession.target === 'codex' && bridgeSession.activityState ? bridgeSession.activityState : formatSessionLabel(bridgeSession)}
                      type="button"
                    >
                      <span>{formatSessionLabel(bridgeSession)}</span>
                      <small>{bridgeSession.cwd}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="session-picker-footer">
              <button
                className="btn btn-secondary"
                disabled={isSendingBulk}
                onClick={() => void bridge.refreshSessions()}
                type="button"
              >
                Refresh
              </button>
              <span>
                Replies stay in the target session. SnapClip only sends the local bundle one-way.
              </span>
            </div>
          </div>
        </div>
      ) : null}

      <p aria-live="polite" className="sr-only" role="status">
        {status}
      </p>

      {/* Fixed dock nav */}
      <nav aria-label="Panel navigation" className="dock-nav">
        <button
          className={`dock-nav-btn${activeTab === 'clips' ? ' is-active' : ''}`}
          onClick={() => handleTabChange('clips')}
          type="button"
        >
          <span aria-hidden="true" className="dock-nav-icon">&#128444;</span>
          Clips
        </button>
        <button
          className={`dock-nav-btn${activeTab === 'session' ? ' is-active' : ''}`}
          onClick={() => handleTabChange('session')}
          type="button"
        >
          <span aria-hidden="true" className="dock-nav-icon">&#128196;</span>
          Session
        </button>
        <button
          className={`dock-nav-btn${activeTab === 'bridge' ? ' is-active' : ''}`}
          onClick={() => handleTabChange('bridge')}
          type="button"
        >
          <span aria-hidden="true" className="dock-nav-icon">&#128279;</span>
          Bridge
        </button>
        <button
          className={`dock-nav-btn${activeTab === 'export' ? ' is-active' : ''}`}
          onClick={() => handleTabChange('export')}
          type="button"
        >
          <span aria-hidden="true" className="dock-nav-icon">&#128228;</span>
          Export
        </button>
      </nav>
    </main>
  );
}
