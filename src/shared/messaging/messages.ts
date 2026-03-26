import type { HandoffIntent, BridgeSession, BridgeTask, BridgeWorkspace } from '../bridge/client';
import type { EvidenceProfile } from '../export/evidence';
import type { ClipAnnotation, ClipHandoffRecord, ClipMode, ClipRect, ClipSession, RuntimeContext } from '../types/session';
import type { HandoffScope } from '../ai/prompts';
import type { PageContext } from '../types/snapshot';

export type OpenSidePanelMessage = {
  type: 'open-side-panel';
};

export type StartClipWorkflowMessage = {
  type: 'start-clip-workflow';
  clipMode: ClipMode;
  tabId?: number;
  windowId?: number;
};

export type OpenClipEditorMessage = {
  type: 'open-clip-editor';
  clipId?: string;
};

export type CommitClipMessage = {
  type: 'commit-clip';
  clipMode: ClipMode;
  title?: string;
  note?: string;
  imageDataUrl: string;
  imageWidth: number;
  imageHeight: number;
  crop: ClipRect;
  pageContext: PageContext;
  runtimeContext: RuntimeContext | null;
  annotations?: ClipAnnotation[];
};

export type GetClipSessionMessage = {
  type: 'get-clip-session';
};

export type GetBridgeWorkspacesMessage = {
  type: 'get-bridge-workspaces';
};

export type GetBridgeSessionsMessage = {
  type: 'get-bridge-sessions';
  workspaceId: string;
};

export type SendBridgeClaudeSessionMessage = {
  type: 'send-bridge-claude-session';
  workspaceId: string;
  sessionId: string;
  clipId?: string;
  draftTitle?: string;
  draftNote?: string;
  draftAnnotations?: ClipAnnotation[];
  intent?: HandoffIntent;
  scope?: HandoffScope;
  evidenceProfile?: EvidenceProfile;
  newClip?: {
    clipMode: ClipMode;
    title?: string;
    note?: string;
    imageDataUrl: string;
    imageWidth: number;
    imageHeight: number;
    crop: ClipRect;
    pageContext: PageContext;
    runtimeContext: RuntimeContext | null;
    annotations?: ClipAnnotation[];
  };
};

export type UpdateClipNoteMessage = {
  type: 'update-clip-note';
  clipId: string;
  note: string;
};

export type UpdateClipTitleMessage = {
  type: 'update-clip-title';
  clipId: string;
  title: string;
};

export type UpdateClipAnnotationsMessage = {
  type: 'update-clip-annotations';
  clipId: string;
  annotations: ClipAnnotation[];
};

export type UpdateClipHandoffMessage = {
  type: 'update-clip-handoff';
  clipId: string;
  handoff: ClipHandoffRecord;
};

export type ExportClipSessionMessage = {
  type: 'export-clip-session';
  format: 'json' | 'markdown';
};

export type OffscreenCopyTextMessage = {
  type: 'offscreen-copy-text';
  text: string;
};

export type OffscreenCopyImageMessage = {
  type: 'offscreen-copy-image';
  dataUrl: string;
};

export type OffscreenCopyPacketMessage = {
  type: 'offscreen-copy-packet';
  dataUrl: string;
  text: string;
};

export type CancelClipOverlayMessage = {
  type: 'cancel-clip-overlay';
  tabId?: number;
};

export type SnapClipMessage =
  | OpenSidePanelMessage
  | StartClipWorkflowMessage
  | OpenClipEditorMessage
  | CommitClipMessage
  | GetClipSessionMessage
  | GetBridgeWorkspacesMessage
  | GetBridgeSessionsMessage
  | SendBridgeClaudeSessionMessage
  | UpdateClipTitleMessage
  | UpdateClipNoteMessage
  | UpdateClipAnnotationsMessage
  | UpdateClipHandoffMessage
  | ExportClipSessionMessage
  | OffscreenCopyTextMessage
  | OffscreenCopyImageMessage
  | OffscreenCopyPacketMessage
  | CancelClipOverlayMessage;

export type SnapClipMessageResponse =
  | { ok: true; session?: ClipSession; workspaces?: BridgeWorkspace[]; sessions?: BridgeSession[]; task?: BridgeTask }
  | { ok: false; error: string };
