import type { ClipAnnotation, ClipMode, ClipRect, ClipSession, RuntimeContext } from '../types/session';
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

export type CancelClipOverlayMessage = {
  type: 'cancel-clip-overlay';
  tabId?: number;
};

export type SnapClipMessage =
  | OpenSidePanelMessage
  | StartClipWorkflowMessage
  | CommitClipMessage
  | GetClipSessionMessage
  | UpdateClipTitleMessage
  | UpdateClipNoteMessage
  | UpdateClipAnnotationsMessage
  | ExportClipSessionMessage
  | OffscreenCopyTextMessage
  | OffscreenCopyImageMessage
  | CancelClipOverlayMessage;

export type SnapClipMessageResponse =
  | { ok: true; session?: ClipSession }
  | { ok: false; error: string };
