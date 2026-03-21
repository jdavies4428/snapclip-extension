import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createBridgeTask,
  getBridgeConfig,
  listBridgeSessions,
  listBridgeWorkspaces,
  setBridgeConfig,
  type BridgeSession,
  type BridgeTaskResponse,
  type BridgeWorkspace,
  type HandoffIntent,
  type HandoffTarget,
} from '../shared/bridge/client';
import type { SnapClipMessageResponse } from '../shared/messaging/messages';
import { STORAGE_KEYS } from '../shared/snapshot/storage';
import type { ClipRecord, ClipSession } from '../shared/types/session';
import { createClipBundleArtifacts } from '../shared/export/bundle';
import { describeEvidenceProfile, type EvidenceProfile } from '../shared/export/evidence';
import { renderAnnotatedClipBlob } from '../shared/export/render-annotated';
import { createClipSessionMarkdown } from '../shared/export/session-markdown';
import { getClipAssetBlob } from '../shared/storage/blob-store';
import { AnnotationCanvas } from './components/AnnotationCanvas';
import { useClipAssetUrl } from './state/useClipAssetUrl';
import { useClipSession } from './state/useClipSession';

type HandoffScope = 'active_clip' | 'session';

type HandoffResult = {
  taskId: string;
  bundlePath: string;
  deliveryState: BridgeTaskResponse['delivery']['state'];
  deliveryTarget: BridgeTaskResponse['delivery']['target'];
  deliveryError: string | null;
  sessionId: string | null;
};

function isBridgeReadyMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'LLM Clip could not reach the local handoff bridge.';
}

async function ensureOffscreenDocument() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/index.html',
      reasons: ['CLIPBOARD'],
      justification: 'Copy clip images and packet summaries from the side panel.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Only a single offscreen document may be created')) {
      throw error;
    }
  }
}

async function copyTextToClipboard(text: string) {
  await ensureOffscreenDocument();
  const response = (await chrome.runtime.sendMessage({
    type: 'offscreen-copy-text',
    text,
  })) as SnapClipMessageResponse;

  if (!response.ok) {
    throw new Error(response.error || 'Clipboard copy failed.');
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const base64 = await blobToBase64(blob);
  return `data:${blob.type || 'image/png'};base64,${base64}`;
}

async function copyBlobImageToClipboard(blob: Blob) {
  await ensureOffscreenDocument();
  const response = (await chrome.runtime.sendMessage({
    type: 'offscreen-copy-image',
    dataUrl: await blobToDataUrl(blob),
  })) as SnapClipMessageResponse;

  if (!response.ok) {
    throw new Error(response.error || 'Image copy failed.');
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary);
}

function ClipThumbnailButton({
  clip,
  index,
  isActive,
  onSelect,
  onEdit,
}: {
  clip: ClipRecord;
  index: number;
  isActive: boolean;
  onSelect: (clipId: string) => void;
  onEdit: (clipId: string) => void;
}) {
  const imageUrl = useClipAssetUrl(clip.imageAssetId);

  return (
    <button
      className={`clip-thumb ${isActive ? 'clip-thumb-active' : ''}`}
      onDoubleClick={() => onEdit(clip.id)}
      onClick={() => onSelect(clip.id)}
      type="button"
    >
      <div className="clip-thumb-image-shell">
        {imageUrl ? (
          <img alt={clip.title || `Clip ${index + 1}`} className="clip-thumb-image" src={imageUrl} />
        ) : (
          <div className="clip-thumb-image clip-thumb-image-loading">Loading...</div>
        )}
        <span className="clip-thumb-mode">{clip.clipMode}</span>
      </div>
      <div className="clip-thumb-copy">
        <strong>{clip.title || `Clip ${index + 1}`}</strong>
        <span>{new Date(clip.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
      </div>
    </button>
  );
}

export default function App() {
  const { session, isLoading } = useClipSession();
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const [status, setStatus] = useState('Start a clip from the popup or with the keyboard shortcut.');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftNote, setDraftNote] = useState('');
  const [bridgeWorkspaces, setBridgeWorkspaces] = useState<BridgeWorkspace[]>([]);
  const [bridgeSessions, setBridgeSessions] = useState<BridgeSession[]>([]);
  const [bridgeError, setBridgeError] = useState('');
  const [bridgeBaseUrl, setBridgeBaseUrl] = useState('http://127.0.0.1:4311');
  const [bridgeToken, setBridgeToken] = useState('snapclip-dev');
  const [isBridgeLoading, setIsBridgeLoading] = useState(false);
  const [isBridgeSubmitting, setIsBridgeSubmitting] = useState(false);
  const [isSessionLoading, setIsSessionLoading] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [handoffTarget, setHandoffTarget] = useState<HandoffTarget>('claude');
  const [handoffIntent, setHandoffIntent] = useState<HandoffIntent>('fix');
  const [handoffScope, setHandoffScope] = useState<HandoffScope>('active_clip');
  const [evidenceProfile, setEvidenceProfile] = useState<EvidenceProfile>('balanced');
  const [handoffResult, setHandoffResult] = useState<HandoffResult | null>(null);
  const [activeOverlayTabId, setActiveOverlayTabId] = useState<number | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);

  useEffect(() => {
    if (!session) {
      return;
    }

    setActiveClipId(session.activeClipId ?? session.clips.at(-1)?.id ?? null);
    setActiveOverlayTabId(null);
  }, [session]);

  const activeClip = useMemo<ClipRecord | null>(() => {
    if (!session) {
      return null;
    }

    return session.clips.find((clip) => clip.id === activeClipId) ?? session.clips.at(-1) ?? null;
  }, [activeClipId, session]);
  const activeClipImageUrl = useClipAssetUrl(activeClip?.imageAssetId ?? null);

  useEffect(() => {
    setDraftTitle(activeClip?.title ?? '');
    setDraftNote(activeClip?.note ?? '');
  }, [activeClip?.id, activeClip?.note, activeClip?.title]);

  useEffect(() => {
    if (!activeClip) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }, 30);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeClip?.id]);

  useEffect(() => {
    if (!session || session.clips.length === 0) {
      return;
    }

    let cancelled = false;

    async function loadBridgeState() {
      setIsBridgeLoading(true);

      try {
        const config = await getBridgeConfig();
        if (cancelled) {
          return;
        }

        setBridgeBaseUrl(config.baseUrl);
        setBridgeToken(config.token);
        const workspaces = await listBridgeWorkspaces();
        if (cancelled) {
          return;
        }

        setBridgeWorkspaces(workspaces);
        setBridgeError(workspaces.length ? '' : 'The local LLM Clip bridge returned no workspaces.');
        setSelectedWorkspaceId((currentValue) => {
          if (currentValue && workspaces.some((workspace) => workspace.id === currentValue)) {
            return currentValue;
          }

          const withSessions = workspaces.find((workspace) => workspace.sessionCount > 0);
          return withSessions?.id ?? workspaces[0]?.id ?? '';
        });
      } catch (error) {
        if (!cancelled) {
          setBridgeError(isBridgeReadyMessage(error));
          setBridgeWorkspaces([]);
          setSelectedWorkspaceId('');
        }
      } finally {
        if (!cancelled) {
          setIsBridgeLoading(false);
        }
      }
    }

    void loadBridgeState();

    return () => {
      cancelled = true;
    };
  }, [session?.id, session?.clips.length]);

  async function saveBridgeSettings() {
    try {
      const config = await setBridgeConfig({
        baseUrl: bridgeBaseUrl,
        token: bridgeToken,
      });

      setBridgeBaseUrl(config.baseUrl);
      setBridgeToken(config.token);
      setStatus('Bridge settings saved. Refreshing workspaces...');

      const workspaces = await listBridgeWorkspaces();
      setBridgeWorkspaces(workspaces);
      setSelectedWorkspaceId((currentValue) => {
        if (currentValue && workspaces.some((workspace) => workspace.id === currentValue)) {
          return currentValue;
        }

        const withSessions = workspaces.find((workspace) => workspace.sessionCount > 0);
        return withSessions?.id ?? workspaces[0]?.id ?? '';
      });
      setBridgeError(workspaces.length ? '' : 'The local LLM Clip bridge returned no workspaces.');
    } catch (error) {
      const message = isBridgeReadyMessage(error);
      setBridgeError(message);
      setStatus(message);
    }
  }

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setBridgeSessions([]);
      setSelectedSessionId('');
      return;
    }

    let cancelled = false;

    async function loadSessions() {
      setIsSessionLoading(true);

      try {
        const sessionsForWorkspace = await listBridgeSessions(selectedWorkspaceId);
        if (cancelled) {
          return;
        }

        setBridgeSessions(sessionsForWorkspace);
        setSelectedSessionId((currentValue) =>
          currentValue && sessionsForWorkspace.some((entry) => entry.id === currentValue)
            ? currentValue
            : '',
        );
      } catch (error) {
        if (!cancelled) {
          setBridgeSessions([]);
          setSelectedSessionId('');
          setBridgeError(isBridgeReadyMessage(error));
        }
      } finally {
        if (!cancelled) {
          setIsSessionLoading(false);
        }
      }
    }

    void loadSessions();

    return () => {
      cancelled = true;
    };
  }, [selectedWorkspaceId]);

  useEffect(() => {
    let cancelled = false;

    async function loadCommandError() {
      const result = await chrome.storage.local.get(STORAGE_KEYS.lastLaunchError);
      const nextError = result[STORAGE_KEYS.lastLaunchError];
      if (!cancelled && typeof nextError === 'string' && nextError.trim()) {
        setStatus(nextError);
      }
    }

    void loadCommandError();

    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local' || !changes[STORAGE_KEYS.lastLaunchError]) {
        return;
      }

      const nextValue = changes[STORAGE_KEYS.lastLaunchError].newValue;
      if (typeof nextValue === 'string' && nextValue.trim()) {
        setStatus(nextValue);
        return;
      }

      setStatus((currentStatus) =>
        currentStatus === changes[STORAGE_KEYS.lastLaunchError].oldValue
          ? 'Start a clip from the popup or with the keyboard shortcut.'
          : currentStatus,
      );
    };

    chrome.storage.onChanged.addListener(handleStorageChange);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(handleStorageChange);
    };
  }, []);

  useEffect(() => {
    if (!activeOverlayTabId) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      void chrome.runtime
        .sendMessage({
          type: 'cancel-clip-overlay',
          tabId: activeOverlayTabId,
        })
        .then((response: SnapClipMessageResponse) => {
          if (response.ok) {
            setStatus('Clip cancelled.');
            setActiveOverlayTabId(null);
          } else {
            setStatus(response.error);
          }
        })
        .catch((error: unknown) => {
          setStatus(error instanceof Error ? error.message : 'Failed to cancel the current clip.');
        });
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeOverlayTabId]);

  async function openPanelForCurrentWindow() {
    const tab = await resolveCaptureTargetTab();
    if (typeof tab?.windowId === 'number') {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    }

    throw new Error('No active browser window was found.');
  }

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

  function getOriginPermissionPattern(url: string): string | null {
    let parsedUrl: URL;

    try {
      parsedUrl = new URL(url);
    } catch {
      return null;
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return null;
    }

    return `${parsedUrl.protocol}//${parsedUrl.hostname}/*`;
  }

  async function ensurePanelCaptureAccess(tabUrl: string): Promise<boolean> {
    const originPattern = getOriginPermissionPattern(tabUrl);
    if (!originPattern) {
      setStatus('LLM Clip only works on normal web pages. Browser pages, extension pages, Chrome Web Store, and PDFs are unsupported.');
      return false;
    }

    const hasAccess = await chrome.permissions.contains({ origins: [originPattern] });
    if (hasAccess) {
      return true;
    }

    setStatus(`Requesting access to ${new URL(tabUrl).hostname} so LLM Clip can clip directly from the side panel...`);
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) {
      setStatus(
        `LLM Clip needs access to ${new URL(tabUrl).hostname} to start captures from the side panel. You can still use the popup or keyboard shortcut.`,
      );
      return false;
    }

    setStatus(`Access granted for ${new URL(tabUrl).hostname}. Starting capture...`);
    return true;
  }

  async function startClip(clipMode: 'visible' | 'region') {
    try {
      const tab = await resolveCaptureTargetTab();
      if (typeof tab?.id !== 'number' || typeof tab.windowId !== 'number' || !tab.url) {
        setStatus('LLM Clip only works on normal web pages. Browser pages, extension pages, Chrome Web Store, and PDFs are unsupported.');
        return;
      }

      const hasAccess = await ensurePanelCaptureAccess(tab.url);
      if (!hasAccess) {
        return;
      }

      setStatus(clipMode === 'visible' ? 'Preparing visible-tab clip...' : 'Preparing region clip...');
      const response = (await chrome.runtime.sendMessage({
        type: 'start-clip-workflow',
        clipMode,
        tabId: tab.id,
        windowId: tab.windowId,
      })) as SnapClipMessageResponse;
      setStatus(
        response.ok
          ? clipMode === 'visible'
            ? 'Visible tab opened in annotation mode.'
            : 'Drag over the current page to select the clip area. Press Esc to cancel.'
          : response.error,
      );
      if (response.ok) {
        setActiveOverlayTabId(tab.id);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to start clip workflow.');
    }
  }

  async function openPanelAgain() {
    try {
      await openPanelForCurrentWindow();
      setStatus('Side panel remains open.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to open the side panel.');
    }
  }

  async function exportSession(format: 'json' | 'markdown') {
    setStatus(`Preparing ${format.toUpperCase()} export...`);
    const response = (await chrome.runtime.sendMessage({
      type: 'export-clip-session',
      format,
    })) as SnapClipMessageResponse;
    setStatus(response.ok ? `${format.toUpperCase()} export started.` : response.error);
  }

  async function saveNote(note: string) {
    if (!activeClip) {
      return;
    }

    await chrome.runtime.sendMessage({
      type: 'update-clip-note',
      clipId: activeClip.id,
      note,
    });
  }

  async function saveTitle(title: string) {
    if (!activeClip) {
      return;
    }

    await chrome.runtime.sendMessage({
      type: 'update-clip-title',
      clipId: activeClip.id,
      title,
    });
  }

  async function saveAnnotations(annotations: ClipRecord['annotations']) {
    if (!activeClip) {
      return;
    }

    const response = (await chrome.runtime.sendMessage({
      type: 'update-clip-annotations',
      clipId: activeClip.id,
      annotations,
    })) as SnapClipMessageResponse;
    setStatus(response.ok ? 'Annotations saved.' : response.error);
  }

  async function copySessionReport(currentSession: ClipSession) {
    try {
      await copyTextToClipboard(createClipSessionMarkdown(currentSession));
      setStatus('Session report copied to the clipboard.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Clipboard copy failed.');
    }
  }

  async function copyCurrentImage() {
    if (!activeClip) {
      return;
    }

    try {
      const blob = await getClipAssetBlob(activeClip.imageAssetId);
      if (!blob) {
        throw new Error('Clip image could not be loaded from local storage.');
      }
      await copyBlobImageToClipboard(blob);
      setStatus('Current clip image copied to the clipboard.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Image copy failed in this browser context.');
    }
  }

  async function copyCurrentInstructions() {
    const instructions = draftNote.trim();
    if (!instructions) {
      setStatus('Add a prompt first, then copy the instructions.');
      return;
    }

    try {
      await copyTextToClipboard(instructions);
      setStatus('Instructions copied to the clipboard.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Clipboard copy failed.');
    }
  }

  async function submitHandoff() {
    if (!session || !activeClip) {
      return;
    }

    if (!selectedWorkspaceId) {
      setStatus('Connect LLM Clip to the local bridge before sending a handoff packet.');
      return;
    }

    setIsBridgeSubmitting(true);
    setHandoffResult(null);
    setBridgeError('');
    setStatus(
      handoffTarget === 'claude'
        ? 'Building a Claude-ready incident packet...'
        : handoffTarget === 'codex'
          ? 'Building a Codex-ready incident packet...'
          : 'Building a local incident packet...',
    );

    try {
      const screenshotBlob = await getClipAssetBlob(activeClip.imageAssetId);
      if (!screenshotBlob) {
        throw new Error('The current clip image could not be loaded from local storage.');
      }

      const annotatedBlob = await renderAnnotatedClipBlob(activeClip, screenshotBlob);
      const artifacts = createClipBundleArtifacts({
        scope: handoffScope,
        target: handoffTarget,
        intent: handoffIntent,
        evidenceProfile,
        activeClip: {
          ...activeClip,
          note: draftNote,
        },
        session: {
          ...session,
          clips: session.clips.map((clip) =>
            clip.id === activeClip.id
              ? {
                  ...clip,
                  note: draftNote,
                }
              : clip,
          ),
        },
      });

      const response = await createBridgeTask({
        workspaceId: selectedWorkspaceId,
        sessionId: handoffTarget === 'claude' && selectedSessionId ? selectedSessionId : null,
        target: handoffTarget,
        intent: handoffIntent,
        payload: {
          title: activeClip.title,
          comment: draftNote.trim(),
          mimeType: 'image/png',
          imageBase64: await blobToBase64(screenshotBlob),
          annotations: activeClip.annotations,
          artifacts: {
            screenshotFileName: 'screenshot.png',
            screenshotBase64: await blobToBase64(screenshotBlob),
            annotatedFileName: 'annotated.png',
            annotatedBase64: await blobToBase64(annotatedBlob),
            context: artifacts.context,
            annotations: artifacts.annotations,
            promptClaude: artifacts.promptClaude,
            promptCodex: artifacts.promptCodex,
          },
        },
      });

      setHandoffResult({
        taskId: response.taskId,
        bundlePath: response.bundlePath,
        deliveryState: response.delivery.state,
        deliveryTarget: response.delivery.target,
        deliveryError: response.delivery.error ?? null,
        sessionId: response.delivery.sessionId,
      });

      setStatus(
        response.delivery.state === 'delivered'
          ? handoffTarget === 'claude'
            ? 'Incident packet delivered to Claude and preserved locally.'
            : 'Incident packet bundle created for Codex and preserved locally.'
          : response.delivery.state === 'failed_after_bundle_creation'
            ? 'Delivery failed after bundle creation. The local incident packet was preserved.'
            : 'Incident packet bundle created locally.',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LLM Clip could not create the incident packet.';
      setBridgeError(message);
      setStatus(message);
    } finally {
      setIsBridgeSubmitting(false);
    }
  }

  useEffect(() => {
    if (!activeClip) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void saveTitle(draftTitle);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeClip, draftTitle]);

  useEffect(() => {
    if (!activeClip) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void saveNote(draftNote);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeClip, draftNote]);

  useEffect(() => {
    if (!isEditorOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsEditorOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isEditorOpen]);

  return (
    <main className="panel-shell">
      <header className="panel-header">
        <div>
          <p className="eyebrow">LLM Clip</p>
          <h1>Clip workspace</h1>
          <p className="subtitle">Clip the current tab, annotate each capture, and build a multi-clip session.</p>
        </div>
        <div className="header-actions">
          <button onClick={() => startClip('visible')} type="button">
            Clip visible tab
          </button>
          <button className="secondary" onClick={() => startClip('region')} type="button">
            Clip area
          </button>
        </div>
      </header>

      <p className="status-banner">{status}</p>

      {isLoading ? (
        <section className="empty-state">
          <h2>Loading clip session...</h2>
        </section>
      ) : session && session.clips.length > 0 && activeClip ? (
        <>
          <section className="workspace-stack">
            <article className="snapshot-card">
              <div className="snapshot-card-header">
                <div className="snapshot-card-title-block">
                  <p className="eyebrow">Active Clip</p>
                  <input
                    className="clip-title-input"
                    onChange={(event) => setDraftTitle(event.target.value)}
                    placeholder="Clip name"
                    ref={titleInputRef}
                    type="text"
                    value={draftTitle}
                  />
                  <p className="subtitle">{activeClip.page.title}</p>
                </div>
                <span className="mode-chip">{activeClip.clipMode}</span>
              </div>

              <div className="annotation-actions">
                <button onClick={copyCurrentImage} type="button">
                  Copy current image
                </button>
                <button className="secondary" onClick={copyCurrentInstructions} type="button">
                  Copy instructions
                </button>
                <button className="secondary" onClick={() => startClip('visible')} type="button">
                  Save and clip visible
                </button>
                <button className="secondary" onClick={() => startClip('region')} type="button">
                  Save and clip area
                </button>
              </div>

              <dl className="meta-grid">
                <div>
                  <dt>Source page</dt>
                  <dd>{activeClip.page.url}</dd>
                </div>
                <div>
                  <dt>Viewport</dt>
                  <dd>
                    {activeClip.page.viewport.width} x {activeClip.page.viewport.height} @ {activeClip.page.viewport.dpr}x
                  </dd>
                </div>
                <div>
                  <dt>Clip area</dt>
                  <dd>
                    {activeClip.crop.width} x {activeClip.crop.height} at {activeClip.crop.x}, {activeClip.crop.y}
                  </dd>
                </div>
              </dl>

              <button
                className="editor-launch-card"
                onDoubleClick={() => setIsEditorOpen(true)}
                onClick={() => setStatus('Double-click the preview to open the editor modal.')}
                type="button"
              >
                {activeClipImageUrl ? (
                  <img alt={activeClip.title} className="screenshot-preview" src={activeClipImageUrl} />
                ) : (
                  <div className="screenshot-preview screenshot-preview-loading">Loading clip preview...</div>
                )}
                <span className="editor-launch-hint">Double-click to open the editor modal</span>
              </button>

              <section className="evidence-section">
                <h3>Prompt for the LLM</h3>
                <textarea
                  className="note-input"
                  key={activeClip.id}
                  onChange={(event) => setDraftNote(event.target.value)}
                  placeholder="Enter prompt for the LLM..."
                  value={draftNote}
                />
              </section>
            </article>

            <aside className="clip-browser">
              <div className="clip-browser-head">
                <div>
                  <p className="eyebrow">Saved Clips</p>
                  <h2>Session gallery</h2>
                </div>
                <span className="context-card-badge">{session.clips.length} saved</span>
              </div>
              <div className="clip-thumb-grid">
                {session.clips.map((clip, index) => (
                  <ClipThumbnailButton
                    clip={clip}
                    index={index}
                    isActive={clip.id === activeClip.id}
                    key={clip.id}
                    onEdit={(clipId) => {
                      setActiveClipId(clipId);
                      setIsEditorOpen(true);
                    }}
                    onSelect={setActiveClipId}
                  />
                ))}
              </div>
            </aside>
          </section>

          {isEditorOpen ? (
            <div className="clip-editor-modal-backdrop" onClick={() => setIsEditorOpen(false)} role="presentation">
              <section
                aria-label="Clip editor"
                className="clip-editor-modal"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="clip-editor-modal-head">
                  <div>
                    <p className="eyebrow">Editor</p>
                    <h2>{draftTitle || activeClip.title || 'Clip'}</h2>
                    <p className="subtitle">Double-click a thumbnail to jump straight into focused editing.</p>
                  </div>
                  <button
                    aria-label="Close editor"
                    className="secondary clip-editor-close"
                    onClick={() => setIsEditorOpen(false)}
                    type="button"
                  >
                    X
                  </button>
                </div>

                <div className="clip-editor-modal-grid">
                  <div className="clip-editor-stage">
                    <AnnotationCanvas clip={activeClip} imageUrl={activeClipImageUrl} onChange={saveAnnotations} />
                  </div>
                  <aside className="clip-editor-sidebar">
                    <label className="field-block">
                      <span>Clip title</span>
                      <input
                        className="clip-title-input clip-title-input-compact"
                        onChange={(event) => setDraftTitle(event.target.value)}
                        placeholder="Clip name"
                        type="text"
                        value={draftTitle}
                      />
                    </label>

                    <div className="annotation-actions">
                      <button onClick={copyCurrentImage} type="button">
                        Copy current image
                      </button>
                      <button className="secondary" onClick={copyCurrentInstructions} type="button">
                        Copy instructions
                      </button>
                      <button className="secondary" onClick={() => setIsEditorOpen(false)} type="button">
                        Done
                      </button>
                    </div>

                    <label className="field-block">
                      <span>Prompt for the LLM</span>
                      <textarea
                        className="note-input"
                        key={`${activeClip.id}-modal`}
                        onChange={(event) => setDraftNote(event.target.value)}
                        placeholder="Enter prompt for the LLM..."
                        value={draftNote}
                      />
                    </label>
                  </aside>
                </div>
              </section>
            </div>
          ) : null}

          <section className="session-context-shell">
            <div className="session-context-head">
              <div>
                <p className="eyebrow">Session Context</p>
                <h2>What this selected clip carries</h2>
              </div>
              <span className="context-card-badge">{activeClip.title || 'Selected clip'}</span>
            </div>

          <section className="export-bar">
            <button className="secondary" onClick={() => copySessionReport(session)} type="button">
              Copy all for Claude
            </button>
            <button className="secondary" onClick={() => exportSession('json')} type="button">
              Export JSON
            </button>
            <button className="secondary" onClick={() => exportSession('markdown')} type="button">
              Export Markdown
            </button>
            <button className="secondary" onClick={openPanelAgain} type="button">
              Keep panel open
            </button>
          </section>
          <section className="handoff-card">
            <div className="handoff-card-head">
              <div>
                <p className="eyebrow">AI Handoff</p>
                <h2>Send a real incident packet</h2>
              </div>
              <span className="context-card-badge">
                {handoffScope === 'session' ? `${session.clips.length} clips in packet` : 'Active clip only'}
              </span>
            </div>
            <p className="subtitle">
              LLM Clip writes a deterministic local bundle, then optionally delivers it through the local bridge.
            </p>

            <div className="handoff-grid">
              <label className="field-block">
                <span>Target</span>
                <select
                  disabled={isBridgeSubmitting}
                  onChange={(event) => setHandoffTarget(event.target.value as HandoffTarget)}
                  value={handoffTarget}
                >
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                  <option value="export_only">Export only</option>
                </select>
              </label>
              <label className="field-block">
                <span>Scope</span>
                <select
                  disabled={isBridgeSubmitting}
                  onChange={(event) => setHandoffScope(event.target.value as HandoffScope)}
                  value={handoffScope}
                >
                  <option value="active_clip">Active clip</option>
                  <option value="session">Whole session</option>
                </select>
              </label>
              <label className="field-block">
                <span>Intent</span>
                <select
                  disabled={isBridgeSubmitting}
                  onChange={(event) => setHandoffIntent(event.target.value as HandoffIntent)}
                  value={handoffIntent}
                >
                  <option value="fix">Investigate and fix</option>
                  <option value="plan">Plan next steps</option>
                  <option value="explain">Explain the issue</option>
                </select>
              </label>
              <label className="field-block">
                <span>Evidence profile</span>
                <select
                  disabled={isBridgeSubmitting}
                  onChange={(event) => setEvidenceProfile(event.target.value as EvidenceProfile)}
                  value={evidenceProfile}
                >
                  <option value="lean">Lean</option>
                  <option value="balanced">Balanced</option>
                  <option value="full">Full</option>
                </select>
              </label>
              <label className="field-block">
                <span>Workspace</span>
                <select
                  disabled={isBridgeLoading || isBridgeSubmitting || bridgeWorkspaces.length === 0}
                  onChange={(event) => setSelectedWorkspaceId(event.target.value)}
                  value={selectedWorkspaceId}
                >
                  {bridgeWorkspaces.length ? (
                    bridgeWorkspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </option>
                    ))
                  ) : (
                    <option value="">Bridge unavailable</option>
                  )}
                </select>
              </label>
              <label className="field-block field-block-wide">
                <span>{handoffTarget === 'claude' ? 'Claude session' : 'Delivery mode'}</span>
                <select
                  disabled={
                    handoffTarget !== 'claude' ||
                    isSessionLoading ||
                    isBridgeSubmitting ||
                    !selectedWorkspaceId
                  }
                  onChange={(event) => setSelectedSessionId(event.target.value)}
                  value={selectedSessionId}
                >
                  <option value="">
                    {handoffTarget === 'claude' ? 'Create bundle only' : 'Bundle only for this target'}
                  </option>
                  {bridgeSessions.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="handoff-actions">
              <button
                disabled={isBridgeLoading || isBridgeSubmitting || !selectedWorkspaceId}
                onClick={submitHandoff}
                type="button"
              >
                {isBridgeSubmitting
                  ? 'Preparing packet...'
                  : handoffTarget === 'claude'
                    ? 'Send to Claude'
                    : handoffTarget === 'codex'
                      ? 'Prepare Codex bundle'
                      : 'Create local bundle'}
              </button>
              <button
                className="secondary"
                disabled={isSessionLoading || isBridgeSubmitting || !selectedWorkspaceId}
                onClick={() => void listBridgeSessions(selectedWorkspaceId).then(setBridgeSessions).catch((error) => setBridgeError(isBridgeReadyMessage(error)))}
                type="button"
              >
                Refresh sessions
              </button>
            </div>

            <div className="handoff-grid">
              <label className="field-block">
                <span>Bridge URL</span>
                <input
                  className="field-input"
                  disabled={isBridgeLoading || isBridgeSubmitting}
                  onChange={(event) => setBridgeBaseUrl(event.target.value)}
                  placeholder="http://127.0.0.1:4311"
                  type="text"
                  value={bridgeBaseUrl}
                />
              </label>
              <label className="field-block">
                <span>Bridge token</span>
                <input
                  className="field-input"
                  disabled={isBridgeLoading || isBridgeSubmitting}
                  onChange={(event) => setBridgeToken(event.target.value)}
                  placeholder="snapclip-dev"
                  type="text"
                  value={bridgeToken}
                />
              </label>
              <div className="field-block field-block-wide">
                <button
                  className="secondary"
                  disabled={isBridgeLoading || isBridgeSubmitting}
                  onClick={() => void saveBridgeSettings()}
                  type="button"
                >
                  Save bridge settings
                </button>
              </div>
            </div>

            <div className="handoff-summary-grid">
              <article className="context-card">
                <div className="context-card-head">
                  <h3>Bundle contents</h3>
                  <span className="context-card-badge">{evidenceProfile}</span>
                </div>
                <p className="evidence-copy">{describeEvidenceProfile(evidenceProfile)}</p>
                <ul className="bundle-list">
                  <li>`screenshot.png`</li>
                  <li>`annotated.png`</li>
                  <li>`context.json`</li>
                  <li>`annotations.json`</li>
                  <li>`prompt-claude.md`</li>
                  <li>`prompt-codex.md`</li>
                </ul>
              </article>
              <article className="context-card">
                <div className="context-card-head">
                  <h3>Delivery status</h3>
                  <span className="context-card-badge">
                    {handoffResult ? handoffResult.deliveryState.replaceAll('_', ' ') : 'Not sent yet'}
                  </span>
                </div>
                {handoffResult ? (
                  <dl className="context-list">
                    <div>
                      <dt>Task ID</dt>
                      <dd>{handoffResult.taskId}</dd>
                    </div>
                    <div>
                      <dt>Bundle path</dt>
                      <dd>{handoffResult.bundlePath}</dd>
                    </div>
                    <div>
                      <dt>Target</dt>
                      <dd>{handoffResult.deliveryTarget}</dd>
                    </div>
                    <div>
                      <dt>Session</dt>
                      <dd>{handoffResult.sessionId || 'Bundle only'}</dd>
                    </div>
                    {handoffResult.deliveryError ? (
                      <div>
                        <dt>Error</dt>
                        <dd>{handoffResult.deliveryError}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : (
                  <p className="evidence-copy">
                    {bridgeError
                      ? bridgeError
                      : 'The local bridge writes the packet into the selected workspace and only then attempts delivery.'}
                  </p>
                )}
              </article>
            </div>
          </section>
          <section className="evidence-stack">
              <section className="evidence-section">
                <h3>Selected text</h3>
                <p className="evidence-copy">{activeClip.domSummary.selectedText || 'No selected text found on clip.'}</p>
              </section>

              <section className="context-grid">
                <article className="context-card">
                  <div className="context-card-head">
                    <h3>Page Metadata</h3>
                    <span className="context-card-badge">
                      {activeClip.runtimeContext?.summary.lastSeenAt
                        ? `Last seen ${new Date(activeClip.runtimeContext.summary.lastSeenAt).toLocaleTimeString()}`
                        : 'No runtime heartbeat'}
                    </span>
                  </div>
                  <dl className="context-list">
                    <div>
                      <dt>Title</dt>
                      <dd>{activeClip.page.title}</dd>
                    </div>
                    <div>
                      <dt>URL</dt>
                      <dd>{activeClip.page.url}</dd>
                    </div>
                    <div>
                      <dt>Viewport</dt>
                      <dd>
                        {activeClip.page.viewport.width} x {activeClip.page.viewport.height} @ {activeClip.page.viewport.dpr}x
                      </dd>
                    </div>
                    <div>
                      <dt>Browser</dt>
                      <dd>{activeClip.page.userAgent}</dd>
                    </div>
                    <div>
                      <dt>Platform</dt>
                      <dd>{activeClip.page.platform}</dd>
                    </div>
                    <div>
                      <dt>Language</dt>
                      <dd>{activeClip.page.language}</dd>
                    </div>
                    <div>
                      <dt>Time zone</dt>
                      <dd>{activeClip.page.timeZone}</dd>
                    </div>
                  </dl>
                </article>

                <article className="context-card">
                  <div className="context-card-head">
                    <h3>Recent Runtime Events</h3>
                    <span className="context-card-badge">
                      {activeClip.runtimeContext
                        ? `${activeClip.runtimeContext.summary.eventCount} captured`
                        : 'Not captured'}
                    </span>
                  </div>
                  {activeClip.runtimeContext?.events.length ? (
                    <div className="runtime-event-list">
                      {activeClip.runtimeContext.events.map((event) => (
                        <article
                          className={`runtime-event runtime-event-${event.level}`}
                          key={`${event.timestamp}-${event.type}-${event.message}`}
                        >
                          <div className="runtime-event-head">
                            <span className="runtime-event-badge">{event.type.replaceAll('_', ' ')}</span>
                            <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
                          </div>
                          <p>{event.message}</p>
                          {event.source ? <code>{event.source}</code> : null}
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="evidence-copy">No runtime issues have been captured yet.</p>
                  )}
                </article>

                <article className="context-card">
                  <div className="context-card-head">
                    <h3>Network Requests</h3>
                    <span className="context-card-badge">
                      {activeClip.runtimeContext
                        ? `${activeClip.runtimeContext.summary.failedRequestCount} failed • ${activeClip.runtimeContext.summary.slowRequestCount} slow`
                        : 'Not captured'}
                    </span>
                  </div>
                  {activeClip.runtimeContext?.network.length ? (
                    <div className="runtime-event-list">
                      {activeClip.runtimeContext.network.map((request) => (
                        <article
                          className={`runtime-event runtime-event-${
                            request.classification === 'failed'
                              ? 'error'
                              : request.classification === 'slow'
                                ? 'warn'
                                : 'log'
                          }`}
                          key={request.id}
                        >
                          <div className="runtime-event-head">
                            <span className="runtime-event-badge">
                              {request.transport} {request.method}
                            </span>
                            <time>{request.durationMs}ms</time>
                          </div>
                          <p>{request.url}</p>
                          <code>
                            status {request.status === null ? 'no-status' : request.status} · {request.classification}
                          </code>
                          {request.error ? <code>{request.error}</code> : null}
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="evidence-copy">No failed or slow requests have been captured yet.</p>
                  )}
                </article>

                <article className="context-card context-card-full">
                  <div className="context-card-head">
                    <h3>Visible Page Summary</h3>
                    <span className="context-card-badge">
                      {activeClip.runtimeContext?.summary.hasDomSummary ? 'DOM summary ready' : 'No DOM summary'}
                    </span>
                  </div>
                  {activeClip.runtimeContext?.domSummary ? (
                    <div className="dom-summary-grid">
                      <div>
                        <dt>Path</dt>
                        <dd>{activeClip.runtimeContext.domSummary.path}</dd>
                      </div>
                      <div>
                        <dt>Headings</dt>
                        <dd>{activeClip.runtimeContext.domSummary.headingTexts.join(', ') || 'None captured'}</dd>
                      </div>
                      <div>
                        <dt>Buttons</dt>
                        <dd>{activeClip.runtimeContext.domSummary.buttonTexts.join(', ') || 'None captured'}</dd>
                      </div>
                      <div>
                        <dt>Fields</dt>
                        <dd>{activeClip.runtimeContext.domSummary.inputLabels.join(', ') || 'None captured'}</dd>
                      </div>
                    </div>
                  ) : (
                    <p className="evidence-copy">No visible page summary has been captured for this clip yet.</p>
                  )}
                </article>
              </section>

              <section className="evidence-section">
                <h3>Headings</h3>
                <ul className="pill-list">
                  {(activeClip.domSummary.headings.length ? activeClip.domSummary.headings : ['None captured']).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>
          </section>
          </section>
        </>
      ) : (
        <section className="empty-state">
          <h2>No clips yet</h2>
          <p>Use the visible-tab or region shortcut on a normal web page to start clipping. Browser pages, extension pages, Chrome Web Store, and PDFs are unsupported for now.</p>
        </section>
      )}
    </main>
  );
}
