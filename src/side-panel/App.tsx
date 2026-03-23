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

function getHostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
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
      aria-pressed={isActive}
      className={`clip-thumb ${isActive ? 'clip-thumb-active' : ''}`}
      onDoubleClick={() => onEdit(clip.id)}
      onClick={() => onSelect(clip.id)}
      title={isActive ? 'Selected clip. Double-click to edit.' : 'Select clip. Double-click to edit.'}
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
  const editorTitleInputRef = useRef<HTMLInputElement | null>(null);
  const editorModalRef = useRef<HTMLElement | null>(null);
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
  const activeClipHost = useMemo(() => (activeClip ? getHostLabel(activeClip.page.url) : ''), [activeClip]);
  const runtimeSummary = activeClip?.runtimeContext?.summary ?? null;
  const chromeDebugger = activeClip?.runtimeContext?.chromeDebugger ?? null;
  const selectedText = activeClip?.domSummary.selectedText?.trim() ?? '';
  const handoffSummary = handoffResult
    ? `${handoffResult.deliveryState.replaceAll('_', ' ')}${handoffResult.deliveryError ? `: ${handoffResult.deliveryError}` : ''}`
    : bridgeError
      ? bridgeError
      : selectedWorkspaceId
        ? 'Creates a local bundle first, then delivers it if possible.'
        : 'Connect the local bridge when you are ready to send.';

  useEffect(() => {
    setDraftTitle(activeClip?.title ?? '');
    setDraftNote(activeClip?.note ?? '');
  }, [activeClip?.id, activeClip?.note, activeClip?.title]);

  useEffect(() => {
    if (!activeClip || isEditorOpen) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }, 30);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeClip?.id, isEditorOpen]);

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

  async function refreshBridgeSessions() {
    if (!selectedWorkspaceId) {
      return;
    }

    setIsSessionLoading(true);

    try {
      const sessionsForWorkspace = await listBridgeSessions(selectedWorkspaceId);
      setBridgeSessions(sessionsForWorkspace);
      setSelectedSessionId((currentValue) =>
        currentValue && sessionsForWorkspace.some((entry) => entry.id === currentValue) ? currentValue : '',
      );
      setBridgeError('');
    } catch (error) {
      setBridgeError(isBridgeReadyMessage(error));
    } finally {
      setIsSessionLoading(false);
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

  async function startClip(clipMode: 'visible' | 'region') {
    try {
      const tab = await resolveCaptureTargetTab();
      if (typeof tab?.id !== 'number' || typeof tab.windowId !== 'number' || !tab.url) {
        setStatus('LLM Clip only works on normal web pages. Browser pages, extension pages, Chrome Web Store, and PDFs are unsupported.');
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

    const timeoutId = window.setTimeout(() => {
      editorTitleInputRef.current?.focus();
      editorTitleInputRef.current?.select();
    }, 30);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsEditorOpen(false);
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const modal = editorModalRef.current;
      if (!modal) {
        return;
      }

      const focusableElements = Array.from(
        modal.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute('disabled'));

      if (!focusableElements.length) {
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement as HTMLElement | null;

      if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
        return;
      }

      if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isEditorOpen]);

  return (
    <main className="panel-shell">
      <div className="panel-frame">
        <header className="panel-header">
          <div className="panel-header-copy">
            <div className="panel-heading-block">
              <p className="eyebrow">LLM Clip</p>
              <h1>Workspace</h1>
              <p className="subtitle">Capture, annotate, export.</p>
            </div>
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

        <div className="panel-status-row">
          <p aria-live="polite" className="status-banner" role="status">
            {status}
          </p>
        </div>

        {isLoading ? (
          <section className="empty-state">
            <p className="eyebrow">Booting workspace</p>
            <h2>Loading clip session...</h2>
            <p>Reassembling local clips, annotations, and runtime evidence for the active session.</p>
          </section>
        ) : session && session.clips.length > 0 && activeClip ? (
          <>
            <section className="workspace-layout">
              <section className="workspace-main">
                <article className="active-clip-card">
                  <div className="active-clip-head">
                    <div className="snapshot-card-title-block">
                      <p className="eyebrow">Active clip</p>
                      <div className="title-row">
                        <input
                          className="clip-title-input"
                          onChange={(event) => setDraftTitle(event.target.value)}
                          placeholder="Clip name"
                          ref={titleInputRef}
                          type="text"
                          value={draftTitle}
                        />
                        <span className="mode-chip">{activeClip.clipMode}</span>
                      </div>
                      <p className="subtitle">{activeClip.page.title}</p>
                      <p className="clip-meta-line">
                        {activeClipHost} • {activeClip.page.viewport.width} x {activeClip.page.viewport.height} @{' '}
                        {activeClip.page.viewport.dpr}x • Crop {activeClip.crop.width} x {activeClip.crop.height}
                      </p>
                    </div>
                  </div>

                  <div className="active-clip-grid">
                    <div className="active-preview-stack">
                      <button
                        aria-label="Open the annotation editor for the active clip"
                        className="preview-stage"
                        onClick={() => setIsEditorOpen(true)}
                        type="button"
                      >
                        {activeClipImageUrl ? (
                          <img alt={activeClip.title} className="screenshot-preview" src={activeClipImageUrl} />
                        ) : (
                          <div className="screenshot-preview screenshot-preview-loading">Loading clip preview...</div>
                        )}
                      </button>
                    </div>

                    <div className="active-clip-sidebar">
                      <div className="annotation-actions annotation-actions-hero">
                        <button onClick={() => setIsEditorOpen(true)} type="button">
                          Open editor
                        </button>
                        <button className="secondary" onClick={copyCurrentImage} type="button">
                          Copy image
                        </button>
                        <button className="secondary" onClick={copyCurrentInstructions} type="button">
                          Copy prompt
                        </button>
                      </div>

                      <label className="field-block prompt-block">
                        <span>Prompt for the LLM</span>
                        <textarea
                          className="note-input"
                          key={activeClip.id}
                          onChange={(event) => setDraftNote(event.target.value)}
                          placeholder="Enter prompt for the LLM..."
                          value={draftNote}
                        />
                      </label>

                      <details className="panel-disclosure">
                        <summary>Clip details</summary>
                        <div className="panel-disclosure-body">
                          <dl className="meta-grid meta-grid-compact">
                            <div>
                              <dt>Source page</dt>
                              <dd>{activeClip.page.url}</dd>
                            </div>
                            <div>
                              <dt>Viewport</dt>
                              <dd>
                                {activeClip.page.viewport.width} x {activeClip.page.viewport.height} @{' '}
                                {activeClip.page.viewport.dpr}x
                              </dd>
                            </div>
                            <div>
                              <dt>Clip area</dt>
                              <dd>
                                {activeClip.crop.width} x {activeClip.crop.height} at {activeClip.crop.x}, {activeClip.crop.y}
                              </dd>
                            </div>
                          </dl>
                        </div>
                      </details>
                    </div>
                  </div>
                </article>

                <section className="handoff-card">
                  <div className="handoff-card-head">
                    <div>
                      <p className="eyebrow">AI handoff</p>
                      <h2>Send bundle</h2>
                    </div>
                  </div>

                  <div className="handoff-grid handoff-grid-primary">
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
                    {handoffTarget === 'claude' ? (
                      <label className="field-block field-block-wide">
                        <span>Claude session</span>
                        <select
                          disabled={isSessionLoading || isBridgeSubmitting || !selectedWorkspaceId}
                          onChange={(event) => setSelectedSessionId(event.target.value)}
                          value={selectedSessionId}
                        >
                          <option value="">Create bundle only</option>
                          {bridgeSessions.map((entry) => (
                            <option key={entry.id} value={entry.id}>
                              {entry.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
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
                    {handoffTarget === 'claude' ? (
                      <button
                        className="secondary"
                        disabled={isSessionLoading || isBridgeSubmitting || !selectedWorkspaceId}
                        onClick={() => void refreshBridgeSessions()}
                        type="button"
                      >
                        Refresh sessions
                      </button>
                    ) : null}
                  </div>

                  <p className="handoff-note">{handoffSummary}</p>

                  <details className="panel-disclosure">
                    <summary>Advanced handoff</summary>
                    <div className="panel-disclosure-body">
                      <div className="handoff-grid">
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
                          <span>Evidence</span>
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
                            <dt>Delivery</dt>
                            <dd>{handoffResult.deliveryTarget}</dd>
                          </div>
                          <div>
                            <dt>Session</dt>
                            <dd>{handoffResult.sessionId || 'Bundle only'}</dd>
                          </div>
                        </dl>
                      ) : null}

                      <p className="evidence-copy">{describeEvidenceProfile(evidenceProfile)}</p>
                    </div>
                  </details>
                </section>

                <section className="session-context-shell">
                  <div className="section-head section-head-compact">
                    <div>
                      <p className="eyebrow">Captured context</p>
                      <h2>Context</h2>
                    </div>
                    <span className="context-card-badge">
                      {runtimeSummary ? `${runtimeSummary.eventCount} events` : 'Optional'}
                    </span>
                  </div>

                  <p className={`context-summary-line ${selectedText ? '' : 'context-summary-line-muted'}`}>
                    {selectedText || 'No selected text was captured for this clip.'}
                  </p>

                  <details className="panel-disclosure">
                    <summary>Show details</summary>
                    <div className="panel-disclosure-body">
                      {activeClip.domSummary.headings.length ? (
                        <div className="panel-disclosure-stack">
                          <p className="panel-disclosure-label">Visible headings</p>
                          <ul className="pill-list">
                            {activeClip.domSummary.headings.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      <dl className="meta-grid meta-grid-compact">
                        <div>
                          <dt>Page</dt>
                          <dd>{activeClip.page.url}</dd>
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
                      </dl>

                      {activeClip.runtimeContext?.events.length ? (
                        <div className="panel-disclosure-stack">
                          <p className="panel-disclosure-label">Recent runtime events</p>
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
                        </div>
                      ) : null}

                      {activeClip.runtimeContext?.network.length ? (
                        <div className="panel-disclosure-stack">
                          <p className="panel-disclosure-label">Network requests</p>
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
                        </div>
                      ) : null}

                      {activeClip.runtimeContext?.domSummary ? (
                        <div className="panel-disclosure-stack">
                          <p className="panel-disclosure-label">Visible page summary</p>
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
                        </div>
                      ) : null}

                      {chromeDebugger ? (
                        <div className="panel-disclosure-stack">
                          <p className="panel-disclosure-label">Chrome debugger snapshot</p>
                          <dl className="meta-grid meta-grid-compact">
                            <div>
                              <dt>Status</dt>
                              <dd>{chromeDebugger.attachError || 'Captured'}</dd>
                            </div>
                            <div>
                              <dt>Frames</dt>
                              <dd>{chromeDebugger.frameCount}</dd>
                            </div>
                            <div>
                              <dt>DOM nodes</dt>
                              <dd>
                                {typeof chromeDebugger.performance.nodes === 'number'
                                  ? chromeDebugger.performance.nodes.toLocaleString()
                                  : 'n/a'}
                              </dd>
                            </div>
                            <div>
                              <dt>Heap used</dt>
                              <dd>
                                {typeof chromeDebugger.performance.jsHeapUsedSize === 'number'
                                  ? `${Math.round(chromeDebugger.performance.jsHeapUsedSize / 1024).toLocaleString()} KB`
                                  : 'n/a'}
                              </dd>
                            </div>
                            <div>
                              <dt>Chrome logs</dt>
                              <dd>{chromeDebugger.logs.length}</dd>
                            </div>
                            <div>
                              <dt>Chrome requests</dt>
                              <dd>{chromeDebugger.network.length}</dd>
                            </div>
                          </dl>

                          {chromeDebugger.logs.length ? (
                            <div className="runtime-event-list">
                              {chromeDebugger.logs.map((entry, index) => (
                                <article
                                  className={`runtime-event runtime-event-${
                                    entry.level === 'error'
                                      ? 'error'
                                      : entry.level === 'warning' || entry.level === 'warn'
                                        ? 'warn'
                                        : 'log'
                                  }`}
                                  key={`${entry.timestamp ?? index}-${entry.source}-${entry.text}`}
                                >
                                  <div className="runtime-event-head">
                                    <span className="runtime-event-badge">
                                      {entry.source} {entry.level}
                                    </span>
                                    <time>
                                      {entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : 'snapshot'}
                                    </time>
                                  </div>
                                  <p>{entry.text}</p>
                                  {entry.url ? <code>{entry.url}</code> : null}
                                </article>
                              ))}
                            </div>
                          ) : null}

                          {chromeDebugger.network.length ? (
                            <div className="runtime-event-list">
                              {chromeDebugger.network.map((request) => (
                                <article
                                  className={`runtime-event runtime-event-${
                                    request.failedReason || request.blockedReason || request.status === null ? 'error' : 'log'
                                  }`}
                                  key={request.id}
                                >
                                  <div className="runtime-event-head">
                                    <span className="runtime-event-badge">
                                      {request.resourceType ? `${request.method} ${request.resourceType}` : request.method}
                                    </span>
                                    <time>{typeof request.status === 'number' ? request.status : 'ERR'}</time>
                                  </div>
                                  <p>{request.url}</p>
                                  <code>
                                    {[request.mimeType, request.failedReason, request.blockedReason].filter(Boolean).join(' · ') ||
                                      'Chrome debugger snapshot'}
                                  </code>
                                </article>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </details>
                </section>
              </section>

              <aside className="workspace-rail">
                <section className="clip-browser">
                  <div className="clip-browser-head">
                    <div>
                      <p className="eyebrow">Saved clips</p>
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
                  <details className="panel-disclosure">
                    <summary>Session tools</summary>
                    <div className="panel-disclosure-body disclosure-actions">
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
                    </div>
                  </details>
                </section>
              </aside>
            </section>

            {isEditorOpen ? (
              <div className="clip-editor-modal-backdrop" onClick={() => setIsEditorOpen(false)} role="presentation">
                <section
                  aria-label="Clip editor"
                  aria-modal="true"
                  className="clip-editor-modal"
                  onClick={(event) => event.stopPropagation()}
                  ref={editorModalRef}
                  role="dialog"
                >
                  <div className="clip-editor-modal-head">
                    <div>
                      <p className="eyebrow">Editor</p>
                      <h2>{draftTitle || activeClip.title || 'Clip'}</h2>
                      <p className="subtitle">Tune the evidence before you copy, export, or send the packet.</p>
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
                          ref={editorTitleInputRef}
                          type="text"
                          value={draftTitle}
                        />
                      </label>

                      <div className="annotation-actions annotation-actions-editor">
                        <button onClick={copyCurrentImage} type="button">
                          Copy image
                        </button>
                        <button className="secondary" onClick={copyCurrentInstructions} type="button">
                          Copy prompt
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
          </>
        ) : (
          <section className="empty-state empty-state-plain">
            <div className="empty-state-copy">
              <p className="eyebrow">Ready</p>
              <h2>No clips yet</h2>
              <p>Clip the current page to start. Browser pages, the Web Store, and PDFs are unsupported.</p>
            </div>
            <div className="empty-state-actions">
              <button onClick={() => startClip('visible')} type="button">
                Clip visible tab
              </button>
              <button className="secondary" onClick={() => startClip('region')} type="button">
                Clip area
              </button>
            </div>
            <p className="empty-state-note">Stored locally until you export or send a bundle.</p>
          </section>
        )}
      </div>
    </main>
  );
}
