import { renderAnnotatedClipBlob } from '../export/render-annotated';
import { getClipAssetBlob } from '../storage/blob-store';
import type { ClipRecord, ClipSession } from '../types/session';
import { createClipBundleArtifacts } from '../export/bundle';
import type { HandoffIntent, HandoffPackageMode, HandoffTarget, BridgeTaskRequest } from './client';
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
  packageMode: HandoffPackageMode;
  scope: HandoffScope;
  evidenceProfile: EvidenceProfile;
  activeClip: ClipRecord;
  session: ClipSession;
  draftTitle: string;
  draftNote: string;
}): Promise<BridgeTaskRequest> {
  const { workspaceId, sessionId, target, intent, packageMode, scope, evidenceProfile, activeClip, session, draftTitle, draftNote } = params;
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
  const orderedSession = {
    ...sessionWithDraftNote,
    clips: [...sessionWithDraftNote.clips].sort(
      (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    ),
  };
  const includedClips = scope === 'session' ? orderedSession.clips : [{
    ...activeClip,
    title: nextTitle,
    note: draftNote,
  }];
  const clipImages = await Promise.all(
    includedClips.map(async (clip, index) => {
      const clipBlob = await getClipAssetBlob(clip.imageAssetId);
      if (!clipBlob) {
        throw new Error(`The image for clip "${clip.title || clip.id}" could not be loaded from local storage.`);
      }

      const clipAnnotatedBlob = await renderAnnotatedClipBlob(clip, clipBlob);
      const order = String(index + 1).padStart(2, '0');

      return {
        clipId: clip.id,
        title: clip.title.trim() || `Clip ${index + 1}`,
        note: clip.note.trim(),
        screenshotFileName: `clips/${order}-${clip.id}-raw.png`,
        screenshotBase64: await blobToBase64(clipBlob),
        annotatedFileName: `clips/${order}-${clip.id}-annotated.png`,
        annotatedBase64: await blobToBase64(clipAnnotatedBlob),
      };
    }),
  );

  const artifacts = createClipBundleArtifacts({
    scope,
    target,
    intent,
    packageMode,
    evidenceProfile,
    activeClip: {
      ...activeClip,
      title: nextTitle,
      note: draftNote,
    },
    session: orderedSession,
  });

  return {
    workspaceId,
    sessionId,
    target,
    intent,
    packageMode,
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
        clipImages,
        clipsManifest: {
          orderedClipIds: clipImages.map((clip) => clip.clipId),
          clips: clipImages.map((clip) => ({
            clipId: clip.clipId,
            title: clip.title,
            note: clip.note ?? '',
            screenshotFileName: clip.screenshotFileName,
            annotatedFileName: clip.annotatedFileName,
          })),
        },
        context: artifacts.context,
        annotations: artifacts.annotations,
        promptClaude: artifacts.promptClaude,
        promptCodex: artifacts.promptCodex,
      },
    },
  };
}
