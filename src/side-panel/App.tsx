import { useMemo, useState } from 'react';
import type { BridgeSession, HandoffPackageMode } from '../shared/bridge/client';
import type { SnapClipMessageResponse } from '../shared/messaging/messages';
import type { ClipRecord } from '../shared/types/session';
import { useClipAssetUrl } from './state/useClipAssetUrl';
import { useClipSession } from './state/useClipSession';
import { useBridgeState } from './state/useBridgeState';

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

function ClipGalleryTile({
  clip,
  index,
  onOpen,
}: {
  clip: ClipRecord;
  index: number;
  onOpen: (clipId: string) => void;
}) {
  const imageUrl = useClipAssetUrl(clip.imageAssetId);

  return (
    <button
      aria-label={`Open ${clip.title || `clip ${index + 1}`} in the page editor`}
      className="clip-gallery-tile"
      onDoubleClick={() => onOpen(clip.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(clip.id);
        }
      }}
      title="Double-click to reopen this clip on the page."
      type="button"
    >
      {imageUrl ? (
        <img
          alt={clip.title || `Saved clip ${index + 1}`}
          className="clip-gallery-image"
          src={imageUrl}
        />
      ) : (
        <div className="clip-gallery-image clip-gallery-image-loading">Loading…</div>
      )}
      <div className="clip-gallery-overlay">
        <span className="clip-gallery-title">{formatClipLabel(clip, index)}</span>
        <span className="clip-gallery-meta">{formatClipMeta(clip)}</span>
      </div>
    </button>
  );
}

export default function App() {
  const { session, isLoading } = useClipSession();
  const [status, setStatus] = useState('');
  const [pendingPackageMode, setPendingPackageMode] = useState<HandoffPackageMode | null>(null);
  const [isSendingBulk, setIsSendingBulk] = useState(false);
  const bridge = useBridgeState({
    enabled: pendingPackageMode !== null,
    reloadKey: pendingPackageMode ?? 'idle',
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

  if (isLoading) {
    return (
      <main className="gallery-shell">
        <section className="gallery-empty">
          <p className="gallery-empty-copy">Loading saved clips…</p>
        </section>
      </main>
    );
  }

  if (!clips.length) {
    return (
      <main className="gallery-shell">
        <section className="gallery-empty">
          <p className="gallery-empty-copy">
            Saved clips appear here. Double-click a thumbnail to reopen it on the page.
          </p>
        </section>
        <p aria-live="polite" className="sr-only" role="status">
          {status}
        </p>
      </main>
    );
  }

  return (
    <main className="gallery-shell">
      <section className="gallery-actions">
        <div className="gallery-actions-copy">
          <strong>Saved images</strong>
          <span>Double-click a thumbnail to reopen it. Bulk send reuses one shared packet when you choose it.</span>
        </div>
        <div className="gallery-actions-buttons">
          <button onClick={() => setPendingPackageMode('image')} type="button">
            Send all images
          </button>
          <button className="secondary" onClick={() => setPendingPackageMode('packet')} type="button">
            Send all + packet
          </button>
        </div>
      </section>

      <section aria-label="Saved clips" className="clip-gallery">
        {clips.map((clip, index) => (
          <ClipGalleryTile clip={clip} index={index} key={clip.id} onOpen={openClipEditor} />
        ))}
      </section>

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
                className="secondary session-picker-close"
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
                  {bridge.bridgeSessions.map((session) => (
                    <button
                      className="session-picker-button secondary"
                      disabled={isSendingBulk}
                      key={session.id}
                      onClick={() => void sendAllToSession(session)}
                      type="button"
                    >
                      <span>{formatSessionLabel(session)}</span>
                      <small>{session.cwd}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="session-picker-footer">
              <button
                className="secondary"
                disabled={isSendingBulk}
                onClick={() => void bridge.refreshSessions()}
                type="button"
              >
                Refresh
              </button>
              <span>
                Replies stay in the target session. LLM Clip only sends the local bundle one-way.
              </span>
            </div>
          </div>
        </div>
      ) : null}

      <p aria-live="polite" className="sr-only" role="status">
        {status}
      </p>
    </main>
  );
}
