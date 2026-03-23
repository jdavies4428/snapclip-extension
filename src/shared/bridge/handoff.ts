import { renderAnnotatedClipBlob } from '../export/render-annotated';
import { getClipAssetBlob } from '../storage/blob-store';
import type { ClipRecord, ClipSession } from '../types/session';
import { createClipBundleArtifacts } from '../export/bundle';
import type { HandoffIntent, HandoffTarget, BridgeTaskRequest } from './client';
import type { HandoffScope } from '../ai/prompts';
import type { EvidenceProfile } from '../export/evidence';

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary);
}

export async function buildBridgeTaskRequest(params: {
  workspaceId: string;
  sessionId: string | null;
  target: HandoffTarget;
  intent: HandoffIntent;
  scope: HandoffScope;
  evidenceProfile: EvidenceProfile;
  activeClip: ClipRecord;
  session: ClipSession;
  draftTitle: string;
  draftNote: string;
}): Promise<BridgeTaskRequest> {
  const { workspaceId, sessionId, target, intent, scope, evidenceProfile, activeClip, session, draftTitle, draftNote } =
    params;
  const nextTitle = draftTitle.trim() || activeClip.title;
  const screenshotBlob = await getClipAssetBlob(activeClip.imageAssetId);

  if (!screenshotBlob) {
    throw new Error('The current clip image could not be loaded from local storage.');
  }

  const annotatedBlob = await renderAnnotatedClipBlob(activeClip, screenshotBlob);
  const sessionWithDraftNote = {
    ...session,
    clips: session.clips.map((clip) =>
      clip.id === activeClip.id
        ? {
            ...clip,
            title: nextTitle,
            note: draftNote,
          }
        : clip,
    ),
  };

  const artifacts = createClipBundleArtifacts({
    scope,
    target,
    intent,
    evidenceProfile,
    activeClip: {
      ...activeClip,
      title: nextTitle,
      note: draftNote,
    },
    session: sessionWithDraftNote,
  });

  return {
    workspaceId,
    sessionId,
    target,
    intent,
    payload: {
      title: nextTitle,
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
  };
}
