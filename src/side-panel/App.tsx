import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  type BridgeTask,
  type HandoffIntent,
  type HandoffTarget,
} from '../shared/bridge/client';
import { buildBridgeTaskRequest } from '../shared/bridge/handoff';
import type { SnapClipMessageResponse } from '../shared/messaging/messages';
import { STORAGE_KEYS } from '../shared/snapshot/storage';
import type {
  ChromeDebuggerHeader,
  ChromeDebuggerNetworkRequest,
  ClipHandoffRecord,
  ClipRecord,
  ClipSession,
} from '../shared/types/session';
import {
  buildActionTimeline,
  describeEvidenceProfile,
  normalizeClipForEvidence,
  type EvidenceProfile,
} from '../shared/export/evidence';
import { createClipSessionMarkdown } from '../shared/export/session-markdown';
import { getClipAssetBlob } from '../shared/storage/blob-store';
import { useClipAssetUrl } from './state/useClipAssetUrl';
import { useBridgeHandoff } from './state/useBridgeHandoff';
import { useBridgeState } from './state/useBridgeState';
import { useClipSession } from './state/useClipSession';

type HandoffScope = 'active_clip' | 'session';
type DebuggerInspectorTab = 'headers' | 'request' | 'response';
type DebuggerRailTab = 'info' | 'console' | 'network' | 'actions' | 'ai';

const DEBUGGER_RAIL_TABS: Array<{
  id: DebuggerRailTab;
  label: string;
  description: string;
  enabled: boolean;
}> = [
  { id: 'info', label: 'Info', description: 'page and capture context', enabled: true },
  { id: 'console', label: 'Console', description: 'runtime and debugger logs', enabled: true },
  { id: 'network', label: 'Network', description: 'request evidence and details', enabled: true },
  { id: 'actions', label: 'Actions', description: 'captured user flow', enabled: true },
  { id: 'ai', label: 'AI', description: 'handoff and analysis', enabled: true },
];

function EvidenceRailEmptyState({
  eyebrow,
  title,
  copy,
  note,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  note?: string;
}) {
  return (
    <section className="debugger-rail-empty">
      <div className="debugger-rail-empty-copy">
        <p className="eyebrow">{eyebrow}</p>
        <h3>{title}</h3>
        <p>{copy}</p>
      </div>
      {note ? <p className="debugger-rail-empty-note">{note}</p> : null}
    </section>
  );
}

function getHandoffStatusMessage(task: BridgeTask, pendingApprovalCount: number) {
  if (task.delivery.state === 'queued') {
    return 'Incident packet queued in the local bridge.';
  }

  if (task.delivery.state === 'delivering') {
    return pendingApprovalCount
      ? `${pendingApprovalCount} Claude approval${pendingApprovalCount === 1 ? '' : 's'} waiting in the local bridge.`
      : 'Delivering the incident packet through the local bridge...';
  }

  if (task.delivery.state === 'delivered') {
    return task.target === 'claude'
      ? 'Incident packet delivered to Claude and preserved locally.'
      : 'Incident packet bundle created and preserved locally.';
  }

  if (task.delivery.state === 'failed_after_bundle_creation') {
    return 'Delivery failed after bundle creation. The local incident packet was preserved.';
  }

  return 'Incident packet bundle created locally.';
}

function getHostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function getDebuggerRequestSeverity(request: ChromeDebuggerNetworkRequest): 0 | 1 | 2 | 3 {
  if (request.failedReason || request.blockedReason || request.status === null) {
    return 3;
  }

  if (typeof request.status === 'number' && request.status >= 400) {
    return 2;
  }

  return request.isTruncated ? 1 : 0;
}

function getDebuggerRequestTone(request: ChromeDebuggerNetworkRequest): 'error' | 'warn' | 'log' {
  return getDebuggerRequestSeverity(request) >= 2 ? 'error' : getDebuggerRequestSeverity(request) === 1 ? 'warn' : 'log';
}

function formatRequestStatus(request: ChromeDebuggerNetworkRequest): string {
  return typeof request.status === 'number' ? String(request.status) : 'ERR';
}

function formatRequestLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname || '/'}${parsed.search || ''}`;
  } catch {
    return url;
  }
}

function formatClipTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatBrowserLabel(userAgent: string): string {
  const patterns: Array<[RegExp, string]> = [
    [/Edg\/([\d.]+)/, 'Edge'],
    [/Chrome\/([\d.]+)/, 'Chrome'],
    [/Firefox\/([\d.]+)/, 'Firefox'],
    [/Version\/([\d.]+).*Safari\//, 'Safari'],
  ];

  for (const [pattern, label] of patterns) {
    const match = userAgent.match(pattern);
    if (match) {
      return `${label} ${match[1].split('.').slice(0, 2).join('.')}`;
    }
  }

  return 'Browser unavailable';
}

function getLogTonePriority(level: string): number {
  if (level === 'error' || level === 'assert') {
    return 0;
  }

  if (level === 'warning' || level === 'warn') {
    return 1;
  }

  return 2;
}

function buildAiNextChecks(
  clip: {
    note: string;
    runtimeContext: ClipRecord['runtimeContext'];
  },
  actionTimelineLength: number,
): string[] {
  const checks: string[] = [];
  const runtimeSummary = clip.runtimeContext?.summary;
  const chromeDebugger = clip.runtimeContext?.chromeDebugger;

  if (runtimeSummary?.failedRequestCount) {
    checks.push('Start with the failing requests in the Network tab and compare them to the last captured route change.');
  }

  if (runtimeSummary?.errorCount) {
    checks.push('Compare the Console tab errors with the route and request sequence to see whether the UI break follows navigation or a request failure.');
  }

  if (chromeDebugger?.attachError) {
    checks.push('Chrome deep network details were unavailable for this page, so rely on runtime evidence or capture again after reproducing the issue.');
  }

  if (!actionTimelineLength) {
    checks.push('Reproduce once with navigation or a user flow so the Actions tab can retain a clearer sequence.');
  }

  if (!clip.note.trim()) {
    checks.push('Add a short agent prompt from Edit on page so the handoff has a concrete debugging goal.');
  }

  if (!checks.length) {
    checks.push('Review Network first, then Console, then use the prompt below to hand the packet to your agent with the smallest missing context.');
  }

  return checks.slice(0, 4);
}

function formatActionTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatEncodedBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || Number.isNaN(bytes) || bytes < 0) {
    return 'n/a';
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 102.4) / 10} KB`;
  }

  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}

function countRedactedHeaders(headers: ChromeDebuggerHeader[] | undefined): number {
  return (headers ?? []).filter((header) => header.redacted).length;
}

function HeaderTable({
  headers,
  emptyLabel,
}: {
  headers: ChromeDebuggerHeader[] | undefined;
  emptyLabel: string;
}) {
  if (!headers?.length) {
    return <p className="network-inspector-empty">{emptyLabel}</p>;
  }

  return (
    <div className="header-table" role="table" aria-label="Header table">
      {headers.map((header, index) => (
        <div className="header-row" key={`${header.name}:${header.value}:${index}`}>
          <dt>{header.name}</dt>
          <dd>{header.value}</dd>
        </div>
      ))}
    </div>
  );
}

function DebuggerNetworkInspector({
  snapshot,
  selectedRequestId,
  onSelectRequest,
  activeTab,
  onTabChange,
}: {
  snapshot: NonNullable<ClipRecord['runtimeContext']>['chromeDebugger'];
  selectedRequestId: string | null;
  onSelectRequest: (requestId: string) => void;
  activeTab: DebuggerInspectorTab;
  onTabChange: (tab: DebuggerInspectorTab) => void;
}) {
  if (!snapshot) {
    return null;
  }

  const sortedRequests = [...snapshot.network].sort((left, right) => {
    const severityDelta = getDebuggerRequestSeverity(right) - getDebuggerRequestSeverity(left);
    if (severityDelta !== 0) {
      return severityDelta;
    }

    return new Date(right.timestamp || 0).getTime() - new Date(left.timestamp || 0).getTime();
  });
  const selectedRequest =
    sortedRequests.find((request) => request.id === selectedRequestId) ?? sortedRequests[0] ?? null;
  const redactedHeaderCount = sortedRequests.reduce(
    (sum, request) =>
      sum + countRedactedHeaders(request.requestHeaders) + countRedactedHeaders(request.responseHeaders),
    0,
  );
  const tabOrder: DebuggerInspectorTab[] = ['headers', 'request', 'response'];
  const panelId = selectedRequest ? `debugger-panel-${selectedRequest.id}-${activeTab}` : 'debugger-panel-empty';

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, tab: DebuggerInspectorTab) => {
    const currentIndex = tabOrder.indexOf(tab);
    if (currentIndex === -1) {
      return;
    }

    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
    } else {
      return;
    }

    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabOrder.length - 1
          : event.key === 'ArrowRight'
            ? (currentIndex + 1) % tabOrder.length
            : (currentIndex - 1 + tabOrder.length) % tabOrder.length;

    const nextTab = tabOrder[nextIndex];
    onTabChange(nextTab);
    window.requestAnimationFrame(() => {
      document.getElementById(`debugger-tab-${selectedRequest.id}-${nextTab}`)?.focus();
    });
  };

  return (
    <div className="network-inspector">
      <div className="network-inspector-head">
        <div className="network-inspector-copy">
          <p className="eyebrow">Deep Network Inspector</p>
          <h3 className="network-inspector-title">Bounded request evidence for this clip</h3>
          <p className="network-inspector-note">
            Bounded local snapshot. Captured during this clip only. Sensitive values may be redacted before storage and export.
          </p>
        </div>
        <div className="network-inspector-summary-grid">
          <div className="network-inspector-metric">
            <span className="network-inspector-metric-value">{sortedRequests.length}</span>
            <span className="network-inspector-metric-label">requests retained</span>
          </div>
          <div className="network-inspector-metric">
            <span className="network-inspector-metric-value">{snapshot.observationWindowMs ?? 0}ms</span>
            <span className="network-inspector-metric-label">capture window</span>
          </div>
          <div className="network-inspector-metric">
            <span className="network-inspector-metric-value">{redactedHeaderCount}</span>
            <span className="network-inspector-metric-label">redacted values</span>
          </div>
        </div>
      </div>

      {snapshot.attachError ? (
        <p className="network-inspector-empty">
          Chrome did not allow the extra deep snapshot for this page. Runtime summary evidence is still attached.
        </p>
      ) : null}

      {!sortedRequests.length ? (
        <p className="network-inspector-empty">
          No request details were captured in the bounded snapshot. If the interesting request happened earlier, capture again and reproduce once.
        </p>
      ) : (
        <div className="network-inspector-grid">
          <div className="request-list" role="list" aria-label="Captured requests">
            {sortedRequests.map((request) => (
              <button
                aria-pressed={selectedRequest?.id === request.id}
                className={`request-row request-row-${getDebuggerRequestTone(request)} ${
                  selectedRequest?.id === request.id ? 'request-row-active' : ''
                }`}
                key={request.id}
                onClick={() => onSelectRequest(request.id)}
                type="button"
              >
                <div className="request-row-head">
                  <span className="runtime-event-badge">
                    {request.resourceType ? `${request.method} ${request.resourceType}` : request.method}
                  </span>
                  <span className="request-row-status">{formatRequestStatus(request)}</span>
                </div>
                <strong>{formatRequestLabel(request.url)}</strong>
                <p>{request.url}</p>
                <div className="request-row-meta">
                  <span>{getHostLabel(request.url)}</span>
                  {request.timestamp ? (
                    <span>{new Date(request.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                  ) : null}
                </div>
                <code>
                  {[
                    request.mimeType,
                    request.failedReason,
                    request.blockedReason,
                    request.fromServiceWorker ? 'service worker' : '',
                    request.fromDiskCache ? 'disk cache' : '',
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'Captured request'}
                </code>
              </button>
            ))}
          </div>

          {selectedRequest ? (
            <section className="request-detail" aria-label="Selected request details">
              <div className="request-detail-head">
                <div className="request-detail-title-block">
                  <p className="panel-disclosure-label">Selected request</p>
                  <h3>{formatRequestLabel(selectedRequest.url)}</h3>
                  <p className="request-detail-subtitle">
                    {getHostLabel(selectedRequest.url)} • {selectedRequest.method} •{' '}
                    {selectedRequest.timestamp
                      ? new Date(selectedRequest.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
                      : 'snapshot'}
                  </p>
                </div>
                <span className={`context-card-badge context-card-badge-${getDebuggerRequestTone(selectedRequest)}`}>
                  {formatRequestStatus(selectedRequest)}
                </span>
              </div>

              <div className="inspector-tabs" role="tablist" aria-label="Request detail tabs">
                {tabOrder.map((tab) => (
                  <button
                    aria-controls={panelId}
                    aria-selected={activeTab === tab}
                    className={`inspector-tab ${activeTab === tab ? 'inspector-tab-active' : ''}`}
                    id={`debugger-tab-${selectedRequest.id}-${tab}`}
                    key={tab}
                    onKeyDown={(event) => handleTabKeyDown(event, tab)}
                    onClick={() => onTabChange(tab)}
                    role="tab"
                    tabIndex={activeTab === tab ? 0 : -1}
                    type="button"
                  >
                    {tab}
                  </button>
                ))}
              </div>

              <dl className="meta-grid meta-grid-compact">
                <div>
                  <dt>URL</dt>
                  <dd>{selectedRequest.url}</dd>
                </div>
                <div>
                  <dt>Method</dt>
                  <dd>{selectedRequest.method}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{formatRequestStatus(selectedRequest)}{selectedRequest.statusText ? ` ${selectedRequest.statusText}` : ''}</dd>
                </div>
                <div>
                  <dt>Type</dt>
                  <dd>{selectedRequest.resourceType || 'n/a'}</dd>
                </div>
              </dl>

              <div className="request-detail-banner">
                <span className="context-card-badge">Local only</span>
                <span className="context-card-badge">{selectedRequest.hasRequestHeaders ? 'Request headers retained' : 'No request headers'}</span>
                <span className="context-card-badge">{selectedRequest.hasResponseHeaders ? 'Response headers retained' : 'No response headers'}</span>
              </div>

              {activeTab === 'headers' ? (
                <div
                  aria-labelledby={`debugger-tab-${selectedRequest.id}-headers`}
                  className="network-inspector-section-stack"
                  id={panelId}
                  role="tabpanel"
                  tabIndex={0}
                >
                  <div className="network-inspector-section">
                    <p className="panel-disclosure-label">Request headers</p>
                    <HeaderTable headers={selectedRequest.requestHeaders} emptyLabel="No request headers were retained." />
                  </div>
                  <div className="network-inspector-section">
                    <p className="panel-disclosure-label">Response headers</p>
                    <HeaderTable headers={selectedRequest.responseHeaders} emptyLabel="No response headers were retained." />
                  </div>
                </div>
              ) : null}

              {activeTab === 'request' ? (
                <div
                  aria-labelledby={`debugger-tab-${selectedRequest.id}-request`}
                  className="network-inspector-section-stack"
                  id={panelId}
                  role="tabpanel"
                  tabIndex={0}
                >
                  <div className="network-inspector-section">
                    <p className="panel-disclosure-label">Request metadata</p>
                    <dl className="meta-grid meta-grid-compact">
                      <div>
                        <dt>Priority</dt>
                        <dd>{selectedRequest.priority || 'n/a'}</dd>
                      </div>
                      <div>
                        <dt>Request body</dt>
                        <dd>{selectedRequest.hasRequestBody ? 'Available on page, not persisted by default' : 'None signaled'}</dd>
                      </div>
                      <div>
                        <dt>Request headers</dt>
                        <dd>{selectedRequest.requestHeaders?.length ?? 0}</dd>
                      </div>
                      <div>
                        <dt>Redactions</dt>
                        <dd>{countRedactedHeaders(selectedRequest.requestHeaders)}</dd>
                      </div>
                    </dl>
                  </div>
                </div>
              ) : null}

              {activeTab === 'response' ? (
                <div
                  aria-labelledby={`debugger-tab-${selectedRequest.id}-response`}
                  className="network-inspector-section-stack"
                  id={panelId}
                  role="tabpanel"
                  tabIndex={0}
                >
                  <div className="network-inspector-section">
                    <p className="panel-disclosure-label">Response metadata</p>
                    <dl className="meta-grid meta-grid-compact">
                      <div>
                        <dt>MIME type</dt>
                        <dd>{selectedRequest.mimeType || 'n/a'}</dd>
                      </div>
                      <div>
                        <dt>Transfer size</dt>
                        <dd>{formatEncodedBytes(selectedRequest.encodedDataLength)}</dd>
                      </div>
                      <div>
                        <dt>Response body</dt>
                        <dd>{selectedRequest.hasResponseBody ? 'Available, not persisted by default' : 'Not retained'}</dd>
                      </div>
                      <div>
                        <dt>Response headers</dt>
                        <dd>{selectedRequest.responseHeaders?.length ?? 0}</dd>
                      </div>
                      <div>
                        <dt>Cache</dt>
                        <dd>{selectedRequest.fromDiskCache ? 'Disk cache' : selectedRequest.fromServiceWorker ? 'Service worker' : 'Network'}</dd>
                      </div>
                      <div>
                        <dt>Blocked or failed</dt>
                        <dd>{selectedRequest.failedReason || selectedRequest.blockedReason || 'No failure reason captured'}</dd>
                      </div>
                    </dl>
                  </div>
                </div>
              ) : null}

              {selectedRequest.isTruncated ? (
                <p className="network-inspector-footnote">Showing a bounded snapshot. Some request details were truncated to keep the packet compact.</p>
              ) : null}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
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
  const handoffLabel = clip.lastHandoff ? getClipHandoffStateLabel(clip.lastHandoff) : '';
  const handoffTone = clip.lastHandoff ? getClipHandoffTone(clip.lastHandoff) : 'neutral';

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
        {clip.lastHandoff ? (
          <>
            <span className={`handoff-chip handoff-chip-${handoffTone} handoff-chip-compact`}>{handoffLabel}</span>
            <span className="clip-thumb-handoff">{getClipHandoffSummary(clip.lastHandoff)}</span>
          </>
        ) : null}
      </div>
    </button>
  );
}

function getClipHandoffStateLabel(handoff: ClipHandoffRecord): string {
  switch (handoff.deliveryState) {
    case 'delivered':
      return 'Delivered';
    case 'failed_after_bundle_creation':
      return 'Saved locally';
    case 'bundle_created':
      return 'Bundle ready';
    case 'delivering':
      return 'Sending';
    case 'queued':
    default:
      return 'Queued';
  }
}

function getClipHandoffTone(handoff: ClipHandoffRecord): 'success' | 'warning' | 'neutral' {
  if (handoff.deliveryState === 'delivered') {
    return 'success';
  }

  if (handoff.deliveryState === 'failed_after_bundle_creation') {
    return 'warning';
  }

  return 'neutral';
}

function getClipHandoffSummary(handoff: ClipHandoffRecord): string {
  const timestamp = new Date(handoff.updatedAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  if (handoff.deliveryState === 'delivered') {
    return handoff.sessionLabel ? `Claude -> ${handoff.sessionLabel} at ${timestamp}` : `Delivered at ${timestamp}`;
  }

  if (handoff.deliveryState === 'failed_after_bundle_creation') {
    return handoff.target === 'claude'
      ? `Claude delivery fell back to a local bundle at ${timestamp}`
      : `Delivery fell back to a local bundle at ${timestamp}`;
  }

  if (handoff.target === 'claude') {
    return handoff.sessionLabel
      ? `Claude bundle for ${handoff.sessionLabel} at ${timestamp}`
      : `Claude bundle only at ${timestamp}`;
  }

  if (handoff.target === 'codex') {
    return `Codex bundle at ${timestamp}`;
  }

  return `Local bundle at ${timestamp}`;
}

export default function App() {
  const { session, isLoading } = useClipSession();
  const completedHandoffIdsRef = useRef<Set<string>>(new Set());
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const [status, setStatus] = useState('Start a clip from the popup or with the keyboard shortcut.');
  const [hasAssignedEditorShortcut, setHasAssignedEditorShortcut] = useState(true);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftNote, setDraftNote] = useState('');
  const [handoffTarget, setHandoffTarget] = useState<HandoffTarget>('claude');
  const [handoffIntent, setHandoffIntent] = useState<HandoffIntent>('fix');
  const [handoffScope, setHandoffScope] = useState<HandoffScope>('active_clip');
  const [evidenceProfile, setEvidenceProfile] = useState<EvidenceProfile>('balanced');
  const [selectedDebuggerRequestId, setSelectedDebuggerRequestId] = useState<string | null>(null);
  const [activeDebuggerInspectorTab, setActiveDebuggerInspectorTab] = useState<DebuggerInspectorTab>('headers');
  const [activeDebuggerRailTab, setActiveDebuggerRailTab] = useState<DebuggerRailTab>('info');
  const [activeOverlayTabId, setActiveOverlayTabId] = useState<number | null>(null);
  const bridgeReloadKey = session ? `${session.id}:${session.clips.length}` : 'no-session';
  const {
    bridgeWorkspaces,
    bridgeSessions,
    bridgeApprovals,
    bridgeError,
    bridgeBaseUrl,
    bridgeToken,
    isBridgeLoading,
    isSessionLoading,
    isApprovalLoading,
    selectedWorkspaceId,
    selectedSessionId,
    setBridgeBaseUrl,
    setBridgeToken,
    setBridgeError,
    setSelectedWorkspaceId,
    setSelectedSessionId,
    saveSettings: persistBridgeSettings,
    refreshSessions: reloadBridgeSessions,
    refreshApprovals,
  } = useBridgeState({
    enabled: Boolean(session?.clips.length),
    reloadKey: bridgeReloadKey,
  });
  const {
    activeTask: handoffTask,
    handoffError,
    isBridgeSubmitting,
    setActiveTask: setHandoffTask,
    setHandoffError,
    submitTask: submitBridgeTask,
  } = useBridgeHandoff();

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
  const runtimeEvents = activeClip?.runtimeContext?.events ?? [];
  const runtimeConsoleEvents = runtimeEvents.filter((event) => event.type !== 'route_change');
  const chromeDebugger = activeClip?.runtimeContext?.chromeDebugger ?? null;
  const sortedRuntimeConsoleEvents = [...runtimeConsoleEvents].sort((left, right) => {
    const priorityDelta = getLogTonePriority(left.level) - getLogTonePriority(right.level);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    return new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime();
  });
  const sortedChromeLogs = [...(chromeDebugger?.logs ?? [])].sort((left, right) => {
    const priorityDelta = getLogTonePriority(left.level) - getLogTonePriority(right.level);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    return new Date(right.timestamp ?? 0).getTime() - new Date(left.timestamp ?? 0).getTime();
  });
  const consoleEventCounts = {
    runtimeErrors: runtimeConsoleEvents.filter((event) => event.level === 'error').length,
    runtimeWarnings: runtimeConsoleEvents.filter((event) => event.level === 'warn').length,
    runtimeLogs: runtimeConsoleEvents.filter((event) => event.level === 'log').length,
    chromeErrors: (chromeDebugger?.logs ?? []).filter((entry) => entry.level === 'error' || entry.level === 'assert')
      .length,
    chromeWarnings: (chromeDebugger?.logs ?? []).filter((entry) => entry.level === 'warning' || entry.level === 'warn')
      .length,
    chromeLogs: (chromeDebugger?.logs ?? []).filter(
      (entry) => entry.level !== 'error' && entry.level !== 'assert' && entry.level !== 'warning' && entry.level !== 'warn',
    ).length,
  };
  const evidenceClip = activeClip ? normalizeClipForEvidence(activeClip, evidenceProfile) : null;
  const evidenceRuntimeSummary = evidenceClip?.runtimeContext?.summary ?? null;
  const actionTimeline = evidenceClip ? buildActionTimeline(evidenceClip) : [];
  const aiNextChecks = evidenceClip ? buildAiNextChecks(evidenceClip, actionTimeline.length) : [];
  const selectedText = activeClip?.domSummary.selectedText?.trim() ?? '';
  const activeDebuggerRailTabMeta =
    DEBUGGER_RAIL_TABS.find((tab) => tab.id === activeDebuggerRailTab) ?? DEBUGGER_RAIL_TABS[0];
  const debuggerRailTabOrder = DEBUGGER_RAIL_TABS.filter((tab) => tab.enabled).map((tab) => tab.id);
  const debuggerRailPanelId = 'debugger-rail-panel';
  const selectedWorkspace = bridgeWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  const selectedBridgeSession = bridgeSessions.find((entry) => entry.id === selectedSessionId) ?? null;
  const handoffSummary = handoffTask
    ? handoffTask.delivery.state === 'delivering' && bridgeApprovals.length
      ? `${bridgeApprovals.length} Claude approval${bridgeApprovals.length === 1 ? '' : 's'} waiting in the local bridge.`
      : `${handoffTask.delivery.state.replaceAll('_', ' ')}${handoffTask.delivery.error ? `: ${handoffTask.delivery.error}` : ''}`
    : handoffError || bridgeError
      ? handoffError || bridgeError
      : selectedWorkspaceId
        ? handoffTarget === 'claude'
          ? selectedBridgeSession
            ? 'Creates a local bundle first, then delivers it into the selected Claude session.'
            : bridgeSessions.length
              ? 'Creates a local Claude bundle only. Choose a live Claude session above to send it directly.'
              : 'Creates a local Claude bundle only. Start Claude locally and install hooks to unlock direct send.'
          : handoffTarget === 'codex'
            ? 'Creates a local Codex bundle you can paste or hand off manually.'
            : 'Creates a local bundle only and keeps it on this machine.'
        : 'Connect the local bridge when you are ready to send.';
  useEffect(() => {
    if (!handoffTask || (handoffTask.delivery.state !== 'queued' && handoffTask.delivery.state !== 'delivering')) {
      return;
    }

    setStatus(getHandoffStatusMessage(handoffTask, bridgeApprovals.length));
  }, [bridgeApprovals.length, handoffTask?.delivery.error, handoffTask?.delivery.state, handoffTask?.id]);

  useEffect(() => {
    if (!selectedWorkspaceId || handoffTarget !== 'claude' || !handoffTask) {
      return;
    }

    const syncApprovals = async () => {
      const approvalSessionId = handoffTask.delivery.sessionId ?? selectedSessionId;
      if (!approvalSessionId) {
        await refreshApprovals(selectedWorkspaceId, '');
        return;
      }

      try {
        await refreshApprovals(selectedWorkspaceId, approvalSessionId);
      } catch {
        // Bridge polling failures should degrade to local state updates, not unhandled rejections.
      }
    };

    if (handoffTask.delivery.state !== 'queued' && handoffTask.delivery.state !== 'delivering') {
      void syncApprovals();
      return;
    }

    void syncApprovals();
    const intervalId = window.setInterval(() => {
      void syncApprovals();
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    handoffTarget,
    handoffTask?.delivery.sessionId,
    handoffTask?.delivery.state,
    handoffTask?.id,
    selectedSessionId,
    selectedWorkspaceId,
  ]);

  useEffect(() => {
    if (handoffTarget !== 'claude' && selectedSessionId) {
      setSelectedSessionId('');
    }
  }, [handoffTarget, selectedSessionId, setSelectedSessionId]);

  useEffect(() => {
    setDraftTitle(activeClip?.title ?? '');
    setDraftNote(activeClip?.note ?? '');
    setSelectedDebuggerRequestId(null);
    setActiveDebuggerInspectorTab('headers');
  }, [activeClip?.id, activeClip?.note, activeClip?.title]);

  useEffect(() => {
    const activeTab = DEBUGGER_RAIL_TABS.find((tab) => tab.id === activeDebuggerRailTab);
    if (activeTab?.enabled !== false) {
      return;
    }

    setActiveDebuggerRailTab('info');
  }, [activeDebuggerRailTab]);

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
    let cancelled = false;

    async function loadEditorShortcutBinding() {
      try {
        const commands = await chrome.commands.getAll();
        if (cancelled) {
          return;
        }

        const editorCommand = commands.find((command) => command.name === 'open-last-clip-editor');
        setHasAssignedEditorShortcut(Boolean(editorCommand?.shortcut?.trim()));
      } catch {
        if (!cancelled) {
          setHasAssignedEditorShortcut(false);
        }
      }
    }

    void loadEditorShortcutBinding();

    return () => {
      cancelled = true;
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

  useEffect(() => {
    if (hasAssignedEditorShortcut) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!activeClip || !event.shiftKey || event.code !== 'KeyE') {
        return;
      }

      const usesEditorShortcut = event.altKey || event.metaKey;
      if (!usesEditorShortcut || event.ctrlKey) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) {
        return;
      }

      event.preventDefault();
      void openClipEditor();
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeClip, hasAssignedEditorShortcut]);

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

  async function saveHandoffMetadata(clipId: string, handoff: ClipHandoffRecord) {
    const response = (await chrome.runtime.sendMessage({
      type: 'update-clip-handoff',
      clipId,
      handoff,
    })) as SnapClipMessageResponse;

    if (!response.ok) {
      throw new Error(response.error || 'Failed to save handoff status locally.');
    }
  }

  async function copySessionReport(currentSession: ClipSession) {
    try {
      await copyTextToClipboard(createClipSessionMarkdown(currentSession, evidenceProfile));
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

  async function saveBridgeSettings() {
    try {
      await persistBridgeSettings({
        baseUrl: bridgeBaseUrl,
        token: bridgeToken,
      });
      setStatus('Bridge settings saved.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save bridge settings.';
      setBridgeError(message);
      setStatus(message);
    }
  }

  async function refreshBridgeSessions() {
    try {
      await reloadBridgeSessions();
      setStatus('Bridge sessions refreshed.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to refresh Claude sessions.';
      setStatus(message);
    }
  }

  async function submitHandoff(scopeOverride: HandoffScope = handoffScope) {
    if (!session || !activeClip) {
      return;
    }

    if (!selectedWorkspaceId) {
      setStatus('Connect LLM Clip to the local bridge before sending a handoff packet.');
      return;
    }

    setHandoffTask(null);
    setHandoffError('');
    setBridgeError('');
    setStatus(
      handoffTarget === 'claude'
        ? 'Building a Claude-ready incident packet...'
        : handoffTarget === 'codex'
          ? 'Building a Codex-ready incident packet...'
          : 'Building a local incident packet...',
    );

    try {
      const handoffClipId = activeClip.id;
      const handoffWorkspaceName = selectedWorkspace?.name ?? selectedWorkspaceId;
      const requestedSessionLabel = selectedBridgeSession?.label ?? null;
      const task = await submitBridgeTask(
        await buildBridgeTaskRequest({
          workspaceId: selectedWorkspaceId,
          sessionId: handoffTarget === 'claude' && selectedSessionId ? selectedSessionId : null,
          target: handoffTarget,
          intent: handoffIntent,
          scope: scopeOverride,
          evidenceProfile,
          activeClip,
          session,
          draftTitle,
          draftNote,
        }),
      );

      const statusMessage =
        task.delivery.state === 'delivered'
          ? handoffTarget === 'claude'
            ? 'Incident packet delivered to Claude and preserved locally.'
            : 'Incident packet bundle created for Codex and preserved locally.'
          : task.delivery.state === 'failed_after_bundle_creation'
            ? 'Delivery failed after bundle creation. The local incident packet was preserved.'
            : task.target === 'claude'
              ? 'Claude incident bundle created locally.'
              : task.target === 'codex'
                ? 'Codex incident bundle created locally.'
                : 'Incident packet bundle created locally.';

      if (!completedHandoffIdsRef.current.has(task.id)) {
        try {
          await saveHandoffMetadata(handoffClipId, {
            taskId: task.id,
            target: task.target,
            deliveryState: task.delivery.state,
            deliveryTarget: task.delivery.target,
            workspaceId: task.workspaceId,
            workspaceName: handoffWorkspaceName,
            sessionId: task.delivery.sessionId,
            sessionLabel: task.delivery.sessionId ? requestedSessionLabel : null,
            bundlePath: task.bundlePath,
            error: task.delivery.error ?? null,
            updatedAt: task.updatedAt,
          });
          completedHandoffIdsRef.current.add(task.id);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'The latest handoff status could not be saved back to this clip.';
          setStatus(`${statusMessage} ${message}`);
          return;
        }
      }

      setStatus(statusMessage);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }

      const message = error instanceof Error ? error.message : 'LLM Clip could not create the incident packet.';
      setBridgeError(message);
      setStatus(message);
    }
  }

  async function openClipEditor(clipId?: string) {
    const targetClipId = clipId ?? activeClip?.id;
    if (!targetClipId) {
      setStatus('Capture a clip first, then open the editor.');
      return;
    }

    if (clipId) {
      setActiveClipId(clipId);
    }

    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'open-clip-editor',
        clipId: targetClipId,
      })) as SnapClipMessageResponse;

      setStatus(response.ok ? 'Opened the clip editor on the page.' : response.error);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to open the clip editor.');
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

  const handleDebuggerRailTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, tab: DebuggerRailTab) => {
    const currentIndex = debuggerRailTabOrder.indexOf(tab);
    if (currentIndex === -1) {
      return;
    }

    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
    } else {
      return;
    }

    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? debuggerRailTabOrder.length - 1
          : event.key === 'ArrowRight'
            ? (currentIndex + 1) % debuggerRailTabOrder.length
            : (currentIndex - 1 + debuggerRailTabOrder.length) % debuggerRailTabOrder.length;

    const nextTab = debuggerRailTabOrder[nextIndex];
    setActiveDebuggerRailTab(nextTab);
    window.requestAnimationFrame(() => {
      document.getElementById(`debugger-rail-tab-${nextTab}`)?.focus();
    });
  };

  function renderDebuggerRailTabContent() {
    if (!activeClip) {
      return (
        <EvidenceRailEmptyState
          eyebrow="No clip"
          title="Capture a clip first"
          copy="The debugger rail appears once the active clip is available, so the evidence stays tied to the current browser state."
          note="Stored locally until you export or send a bundle."
        />
      );
    }

    switch (activeDebuggerRailTab) {
      case 'info':
        return (
          <div className="debugger-rail-stack">
            <section className="debugger-rail-section">
              <div className="section-head section-head-compact">
                <div>
                  <p className="panel-disclosure-label">Info</p>
                  <h3>Clip and page context</h3>
                </div>
                <span className="context-card-badge">
                  {runtimeSummary ? `${runtimeSummary.eventCount} runtime events` : 'No runtime summary'}
                </span>
              </div>

              <p className={`context-summary-line ${selectedText ? '' : 'context-summary-line-muted'}`}>
                {selectedText || 'No selected text was captured for this clip.'}
              </p>

              <div className="debugger-rail-metric-grid">
                <div className="debugger-rail-metric">
                  <span className="debugger-rail-metric-value">{formatClipTimestamp(activeClip.createdAt)}</span>
                  <span className="debugger-rail-metric-label">captured</span>
                </div>
                <div className="debugger-rail-metric">
                  <span className="debugger-rail-metric-value">{formatBrowserLabel(activeClip.page.userAgent)}</span>
                  <span className="debugger-rail-metric-label">browser</span>
                </div>
                <div className="debugger-rail-metric">
                  <span className="debugger-rail-metric-value">
                    {activeClip.page.viewport.width} x {activeClip.page.viewport.height}
                  </span>
                  <span className="debugger-rail-metric-label">viewport</span>
                </div>
              </div>

              <dl className="meta-grid meta-grid-compact">
                <div>
                  <dt>Page</dt>
                  <dd>{activeClip.page.url}</dd>
                </div>
                <div>
                  <dt>Host</dt>
                  <dd>{activeClipHost || 'n/a'}</dd>
                </div>
                <div>
                  <dt>Time zone</dt>
                  <dd>{activeClip.page.timeZone}</dd>
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
                  <dt>Debugger</dt>
                  <dd>{chromeDebugger?.attachError || 'Captured locally'}</dd>
                </div>
              </dl>
            </section>

            {activeClip.domSummary.headings.length ? (
              <section className="debugger-rail-section">
                <p className="panel-disclosure-label">Visible headings</p>
                <ul className="pill-list">
                  {activeClip.domSummary.headings.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            {activeClip.runtimeContext?.domSummary ? (
              <section className="debugger-rail-section">
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
              </section>
            ) : null}

            {chromeDebugger ? (
              <section className="debugger-rail-section">
                <p className="panel-disclosure-label">Debugger snapshot</p>
                <dl className="meta-grid meta-grid-compact">
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
                  <div>
                    <dt>Capture</dt>
                    <dd>{chromeDebugger.attachError || 'Bounded local snapshot'}</dd>
                  </div>
                </dl>
              </section>
            ) : null}
          </div>
        );

      case 'console':
        return sortedRuntimeConsoleEvents.length || sortedChromeLogs.length ? (
          <div className="debugger-rail-stack">
            <section className="debugger-rail-section">
              <div className="section-head section-head-compact">
                <div>
                  <p className="panel-disclosure-label">Diagnostics</p>
                  <h3>Severity snapshot</h3>
                </div>
                <span className="context-card-badge">{sortedRuntimeConsoleEvents.length + sortedChromeLogs.length} retained</span>
              </div>
              <div className="debugger-rail-metric-grid">
                <div className="debugger-rail-metric">
                  <span className="debugger-rail-metric-value">{consoleEventCounts.runtimeErrors + consoleEventCounts.chromeErrors}</span>
                  <span className="debugger-rail-metric-label">errors</span>
                </div>
                <div className="debugger-rail-metric">
                  <span className="debugger-rail-metric-value">
                    {consoleEventCounts.runtimeWarnings + consoleEventCounts.chromeWarnings}
                  </span>
                  <span className="debugger-rail-metric-label">warnings</span>
                </div>
                <div className="debugger-rail-metric">
                  <span className="debugger-rail-metric-value">{consoleEventCounts.runtimeLogs + consoleEventCounts.chromeLogs}</span>
                  <span className="debugger-rail-metric-label">logs</span>
                </div>
              </div>
            </section>

            {sortedRuntimeConsoleEvents.length ? (
              <section className="debugger-rail-section">
                <div className="section-head section-head-compact">
                  <div>
                    <p className="panel-disclosure-label">Runtime events</p>
                    <h3>Console summary</h3>
                  </div>
                  <span className="context-card-badge">
                    {sortedRuntimeConsoleEvents.length} event{sortedRuntimeConsoleEvents.length === 1 ? '' : 's'}
                  </span>
                </div>
                <p className="debugger-rail-note">
                  App-level exceptions, warnings, and logs captured from the page runtime. Navigation changes are reserved for the Actions tab.
                </p>
                <div className="runtime-event-list">
                  {sortedRuntimeConsoleEvents.map((event) => (
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
              </section>
            ) : null}

            {sortedChromeLogs.length ? (
              <section className="debugger-rail-section">
                <div className="section-head section-head-compact">
                  <div>
                    <p className="panel-disclosure-label">Chrome logs</p>
                    <h3>Debugger output</h3>
                  </div>
                  <span className="context-card-badge">{sortedChromeLogs.length} entries</span>
                </div>
                <p className="debugger-rail-note">
                  Chrome debugger output is useful when the page runtime is quiet but the browser still sees warnings or protocol-level errors.
                </p>
                <div className="runtime-event-list">
                  {sortedChromeLogs.map((entry, index) => (
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
                        <time>{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : 'snapshot'}</time>
                      </div>
                      <p>{entry.text}</p>
                      {entry.url ? <code>{entry.url}</code> : null}
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : (
          <EvidenceRailEmptyState
            eyebrow="Console"
            title="No runtime console signals"
            copy="Console logs and runtime events will show up here once this clip captures them."
            note="The evidence rail still keeps the network and clip context available above."
          />
        );

      case 'network':
        return activeClip.runtimeContext?.network.length || chromeDebugger ? (
          <div className="debugger-rail-stack">
            {activeClip.runtimeContext?.network.length ? (
              <section className="debugger-rail-section">
                <div className="section-head section-head-compact">
                  <div>
                    <p className="panel-disclosure-label">Runtime requests</p>
                    <h3>Network activity</h3>
                  </div>
                  <span className="context-card-badge">
                    {activeClip.runtimeContext.network.length} request{activeClip.runtimeContext.network.length === 1 ? '' : 's'}
                  </span>
                </div>
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
              </section>
            ) : null}

            {chromeDebugger ? (
              <DebuggerNetworkInspector
                activeTab={activeDebuggerInspectorTab}
                onSelectRequest={setSelectedDebuggerRequestId}
                onTabChange={setActiveDebuggerInspectorTab}
                selectedRequestId={selectedDebuggerRequestId}
                snapshot={chromeDebugger}
              />
            ) : null}
          </div>
        ) : (
          <EvidenceRailEmptyState
            eyebrow="Network"
            title="No captured requests"
            copy="This clip did not retain a network trace yet. Capture the page again to bring the request list and deep inspector back."
            note="The rail still stays in place, so the clip and its context do not jump around."
          />
        );

      case 'actions':
        return actionTimeline.length ? (
          <div className="debugger-rail-stack">
            <section className="debugger-rail-section">
              <div className="section-head section-head-compact">
                <div>
                  <p className="panel-disclosure-label">Actions</p>
                  <h3>Captured flow</h3>
                </div>
                <span className="context-card-badge">{actionTimeline.length} events</span>
              </div>
              <div className="debugger-rail-metric-grid">
                <div className="debugger-rail-metric">
                  <span className="debugger-rail-metric-value">
                    {actionTimeline.filter((entry) => entry.kind === 'route').length}
                  </span>
                  <span className="debugger-rail-metric-label">route changes</span>
                </div>
                <div className="debugger-rail-metric">
                  <span className="debugger-rail-metric-value">
                    {actionTimeline.filter((entry) => entry.kind === 'request_failed').length}
                  </span>
                  <span className="debugger-rail-metric-label">failed requests</span>
                </div>
                <div className="debugger-rail-metric">
                  <span className="debugger-rail-metric-value">
                    {actionTimeline.filter((entry) => entry.kind === 'request_slow').length}
                  </span>
                  <span className="debugger-rail-metric-label">slow requests</span>
                </div>
              </div>
              <p className="debugger-rail-note">
                A bounded timeline built from route changes plus failed or slow requests captured during this clip.
              </p>
              {actionTimeline.length >= 12 ? (
                <p className="debugger-rail-note">
                  Showing the most recent bounded slice of the captured flow for this clip.
                </p>
              ) : null}
            </section>

            <section className="debugger-rail-section">
              <div className="action-timeline" role="list" aria-label="Captured actions timeline">
                {actionTimeline.map((entry) => (
                  <article className={`action-timeline-entry action-timeline-entry-${entry.tone}`} key={entry.id} role="listitem">
                    <div className="action-timeline-time">{formatActionTimestamp(entry.timestamp)}</div>
                    <div className="action-timeline-copy">
                      <p className="action-timeline-label">{entry.label}</p>
                      <p className="action-timeline-detail">{entry.detail}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>
        ) : (
          <EvidenceRailEmptyState
            eyebrow="Actions"
            title="No timeline evidence yet"
            copy="This clip did not retain enough route, request, or runtime signals to build a readable flow."
            note="Capture again and reproduce once if the bug depends on navigation or a request sequence."
          />
        );

      case 'ai':
        return (
          <div className="debugger-rail-stack">
            <section className="debugger-rail-section">
              <div className="section-head section-head-compact">
                <div>
                  <p className="panel-disclosure-label">AI handoff</p>
                  <h3>Agent-ready packet</h3>
                </div>
                <span className="context-card-badge">{handoffTarget}</span>
              </div>
              <div className="debugger-rail-metric-grid">
                <div className="debugger-rail-metric">
                  <span className="debugger-rail-metric-value">{evidenceProfile}</span>
                  <span className="debugger-rail-metric-label">evidence profile</span>
                </div>
                <div className="debugger-rail-metric">
                  <span className="debugger-rail-metric-value">{evidenceRuntimeSummary?.failedRequestCount ?? 0}</span>
                  <span className="debugger-rail-metric-label">failed requests</span>
                </div>
                <div className="debugger-rail-metric">
                  <span className="debugger-rail-metric-value">{actionTimeline.length}</span>
                  <span className="debugger-rail-metric-label">timeline events</span>
                </div>
              </div>
              <p className="debugger-rail-note">
                The prompt, screenshot, and bounded evidence bundle stay local until you explicitly export or send them.
              </p>
            </section>

            <section className="debugger-rail-section">
              <p className="panel-disclosure-label">Prompt</p>
              <div className={`prompt-preview ${draftNote.trim() ? '' : 'prompt-preview-empty'}`}>
                {draftNote.trim() || 'No prompt yet. Use Edit on page to add instructions for the model.'}
              </div>
            </section>

            <section className="debugger-rail-section">
              <p className="panel-disclosure-label">Next checks</p>
              <ul className="debugger-rail-checklist">
                {aiNextChecks.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          </div>
        );
    }

    return null;
  }

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
                        <div className="active-clip-title-stack">
                          <h2 className="active-clip-title">{draftTitle || activeClip.title || 'Clip'}</h2>
                          <p className="subtitle">{activeClip.page.title}</p>
                        </div>
                        <span className="mode-chip">{activeClip.clipMode}</span>
                      </div>
                      <p className="clip-meta-line">
                        {activeClipHost} • {activeClip.page.viewport.width} x {activeClip.page.viewport.height} @{' '}
                        {activeClip.page.viewport.dpr}x • Crop {activeClip.crop.width} x {activeClip.crop.height}
                      </p>
                      {activeClip.lastHandoff ? (
                        <div className="active-clip-handoff">
                          <span
                            className={`handoff-chip handoff-chip-${getClipHandoffTone(activeClip.lastHandoff)}`}
                          >
                            {getClipHandoffStateLabel(activeClip.lastHandoff)}
                          </span>
                          <p>{getClipHandoffSummary(activeClip.lastHandoff)}</p>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="active-clip-grid">
                    <div className="active-preview-stack">
                      <button
                        aria-label="Open the annotation editor on the page"
                        className="preview-stage"
                        onClick={() => void openClipEditor()}
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
                        <button onClick={() => void openClipEditor()} type="button">
                          Edit on page
                        </button>
                        <button className="secondary" onClick={copyCurrentImage} type="button">
                          Copy image
                        </button>
                        <button className="secondary" onClick={copyCurrentInstructions} type="button">
                          Copy prompt
                        </button>
                      </div>

                      <div className="field-block">
                        <span>Prompt for the LLM</span>
                        <div className={`prompt-preview ${draftNote.trim() ? '' : 'prompt-preview-empty'}`}>
                          {draftNote.trim() || 'No prompt yet. Use Edit on page to add instructions for the model.'}
                        </div>
                      </div>

                      <p className="preview-caption">Double-click a saved clip to reopen it in the page editor.</p>

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
                      onClick={() => void submitHandoff()}
                      type="button"
                    >
                      {isBridgeSubmitting
                        ? 'Preparing packet...'
                        : handoffTarget === 'claude'
                          ? selectedBridgeSession
                            ? 'Send to Claude'
                            : 'Create Claude bundle'
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

                      {handoffTask ? (
                        <dl className="context-list">
                          <div>
                            <dt>Task ID</dt>
                            <dd>{handoffTask.id}</dd>
                          </div>
                          <div>
                            <dt>Bundle path</dt>
                            <dd>{handoffTask.bundlePath}</dd>
                          </div>
                          <div>
                            <dt>Delivery</dt>
                            <dd>{handoffTask.delivery.target}</dd>
                          </div>
                          <div>
                            <dt>Status</dt>
                            <dd>{handoffTask.status.replaceAll('_', ' ')}</dd>
                          </div>
                          <div>
                            <dt>Session</dt>
                            <dd>{handoffTask.delivery.sessionId || 'Bundle only'}</dd>
                          </div>
                        </dl>
                      ) : null}

                      <p className="evidence-copy">{describeEvidenceProfile(evidenceProfile)}</p>
                    </div>
                  </details>
                </section>

                <section className="session-context-shell debugger-rail-shell">
                  <div className="debugger-rail-head">
                    <div className="section-head section-head-compact">
                      <div className="debugger-rail-copy">
                        <p className="eyebrow">Debugger rail</p>
                        <h2>Captured evidence</h2>
                        <p className="network-inspector-note">
                          Persistent local snapshot for the active clip. Showing {activeDebuggerRailTabMeta.description}.
                        </p>
                      </div>
                      <span className="context-card-badge">Local only</span>
                    </div>

                    <div className="debugger-rail-tabs" role="tablist" aria-label="Debugger rail tabs">
                      {DEBUGGER_RAIL_TABS.map((tab) => (
                        <button
                          aria-controls={debuggerRailPanelId}
                          aria-disabled={tab.enabled ? undefined : true}
                          aria-selected={activeDebuggerRailTab === tab.id}
                          className={`debugger-rail-tab ${activeDebuggerRailTab === tab.id ? 'debugger-rail-tab-active' : ''} ${
                            tab.enabled ? '' : 'debugger-rail-tab-disabled'
                          }`}
                          disabled={!tab.enabled}
                          id={`debugger-rail-tab-${tab.id}`}
                          key={tab.id}
                          onClick={() => setActiveDebuggerRailTab(tab.id)}
                          onKeyDown={(event) => handleDebuggerRailTabKeyDown(event, tab.id)}
                          role="tab"
                          tabIndex={activeDebuggerRailTab === tab.id ? 0 : -1}
                          title={tab.description}
                          type="button"
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div
                    aria-labelledby={`debugger-rail-tab-${activeDebuggerRailTab}`}
                    className="debugger-rail-panel"
                    id={debuggerRailPanelId}
                    role="tabpanel"
                    tabIndex={0}
                  >
                    {renderDebuggerRailTabContent()}
                  </div>
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
                          onEdit={openClipEditor}
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
