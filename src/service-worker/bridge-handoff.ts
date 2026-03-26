import {
  createBridgeTask,
  getBridgeHealth,
  listBridgeActiveSessions,
  listBridgeSessions,
  listBridgeWorkspaces,
  waitForBridgeTask,
  type BridgeHealth,
  type BridgeSession,
  type BridgeTask,
  type BridgeWorkspace,
} from '../shared/bridge/client';
import { buildBridgeTaskRequest } from '../shared/bridge/handoff';
import type { SendBridgeSessionMessage } from '../shared/messaging/messages';
import type { HandoffIntent, HandoffPackageMode, HandoffTarget } from '../shared/bridge/client';
import type { HandoffScope } from '../shared/ai/prompts';
import type { EvidenceProfile } from '../shared/export/evidence';
import type { ClipHandoffRecord, ClipRecord, ClipSession } from '../shared/types/session';
import { commitClipToSession } from './session';
import { getClipSession, getStoredClipRecord, updateClipDraft, updateClipHandoff } from './storage';

function createPendingTask(
  acceptedTask: Awaited<ReturnType<typeof createBridgeTask>>,
  request: Awaited<ReturnType<typeof buildBridgeTaskRequest>>,
): BridgeTask {
  const now = new Date().toISOString();

  return {
    id: acceptedTask.taskId,
    createdAt: now,
    updatedAt: now,
    status: acceptedTask.status,
    workspaceId: request.workspaceId,
    sessionId: acceptedTask.delivery.sessionId,
    target: request.target,
    intent: request.intent,
    title: request.payload.title,
    bundlePath: acceptedTask.bundlePath,
    bundleSignature: '',
    delivery: acceptedTask.delivery,
  };
}

async function resolveSavedClipForSend(
  clipId?: string,
  allowFallback = true,
): Promise<{ session: ClipSession; clip: ClipRecord; clipId: string } | null> {
  const session = await getClipSession();
  if (!session) {
    return null;
  }

  const resolvedClipId = clipId?.trim() || (allowFallback ? session.activeClipId || session.clips.at(-1)?.id || '' : '');
  if (!resolvedClipId) {
    return null;
  }

  const clip = await getStoredClipRecord(resolvedClipId);
  if (!clip) {
    throw new Error('The current clip is no longer available.');
  }

  return { session, clip, clipId: resolvedClipId };
}

async function persistClipDraftForSend(
  params: SendBridgeSessionMessage,
): Promise<{ session: ClipSession; clip: ClipRecord; clipId: string }> {
  const hasExplicitClipId = Boolean(params.clipId?.trim());
  const savedClip = await resolveSavedClipForSend(params.clipId, !params.newClip || hasExplicitClipId);

  if (savedClip && (hasExplicitClipId || !params.newClip)) {
    const nextTitle = params.draftTitle?.trim() || savedClip.clip.title;
    const nextNote = params.draftNote ?? savedClip.clip.note;
    const nextAnnotations = params.draftAnnotations ?? savedClip.clip.annotations;

    await updateClipDraft(savedClip.clipId, {
      title: nextTitle,
      note: nextNote,
      annotations: nextAnnotations,
    });

    const session = await getClipSession();
    const clip = await getStoredClipRecord(savedClip.clipId);
    if (!session || !clip) {
      throw new Error('The updated clip could not be reloaded for session delivery.');
    }

    return { session, clip, clipId: savedClip.clipId };
  }

  if (!params.newClip) {
    throw new Error('Capture a clip first before sending to an agent session.');
  }

  const session = await commitClipToSession({
    clipMode: params.newClip.clipMode,
    title: params.newClip.title,
    note: params.newClip.note,
    imageDataUrl: params.newClip.imageDataUrl,
    imageWidth: params.newClip.imageWidth,
    imageHeight: params.newClip.imageHeight,
    crop: params.newClip.crop,
    pageContext: params.newClip.pageContext,
    runtimeContext: params.newClip.runtimeContext,
    annotations: params.newClip.annotations ?? [],
  });
  const clipId = session.activeClipId ?? session.clips.at(-1)?.id ?? '';
  if (!clipId) {
    throw new Error('The new clip could not be saved before session delivery.');
  }

  const clip = await getStoredClipRecord(clipId);
  if (!clip) {
    throw new Error('The saved clip could not be reloaded for session delivery.');
  }

  return { session, clip, clipId };
}

function resolveWorkspaceName(workspaces: BridgeWorkspace[], workspaceId: string): string {
  return workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? workspaceId;
}

function resolveSessionLabel(sessions: BridgeSession[], sessionId: string): string | null {
  return sessions.find((session) => session.id === sessionId)?.label ?? null;
}

function buildHandoffRecord(params: {
  task: BridgeTask;
  workspaceName: string;
  sessionLabel: string | null;
  packageMode: HandoffPackageMode;
}): ClipHandoffRecord {
  const { task, workspaceName, sessionLabel, packageMode } = params;

  return {
    taskId: task.id,
    target: task.target,
    packageMode,
    deliveryState: task.delivery.state,
    deliveryTarget: task.delivery.target,
    workspaceId: task.workspaceId,
    workspaceName,
    sessionId: task.delivery.sessionId,
    sessionLabel,
    bundlePath: task.bundlePath,
    error: task.delivery.error ?? null,
    updatedAt: task.updatedAt,
  };
}

export async function loadBridgeWorkspaces(): Promise<BridgeWorkspace[]> {
  return listBridgeWorkspaces();
}

export async function loadBridgeHealth(): Promise<BridgeHealth> {
  return getBridgeHealth();
}

export async function loadBridgeSessions(workspaceId: string): Promise<BridgeSession[]> {
  if (!workspaceId.trim()) {
    throw new Error('workspaceId is required.');
  }

  return listBridgeSessions(workspaceId);
}

export async function loadBridgeActiveSessions(): Promise<BridgeSession[]> {
  return listBridgeActiveSessions();
}

export async function sendClipToBridgeSession(
  params: SendBridgeSessionMessage,
): Promise<{ session: ClipSession; task: BridgeTask }> {
  const { session, clip, clipId } = await persistClipDraftForSend(params);
  const draftTitle = params.draftTitle?.trim() || clip.title;
  const draftNote = params.draftNote ?? clip.note;
  const target = params.target;
  const packageMode = params.packageMode ?? 'packet';
  const workspaceId = params.workspaceId.trim();
  const sessionId = params.sessionId.trim();
  const intent = params.intent ?? 'fix';
  const scope = params.scope ?? 'active_clip';
  const evidenceProfile = params.evidenceProfile ?? 'balanced';
  const [workspaces, liveSessions] = await Promise.all([
    listBridgeWorkspaces().catch(() => []),
    listBridgeSessions(workspaceId).catch(() => []),
  ]);
  const workspaceName = resolveWorkspaceName(workspaces, workspaceId);
  const sessionLabel = resolveSessionLabel(
    liveSessions.filter((session) => session.target === target),
    sessionId,
  );
  const sessionForBundle = {
    ...session,
    clips: session.clips.map((existingClip) =>
      existingClip.id === clipId
        ? {
            ...existingClip,
            title: draftTitle,
            note: draftNote,
          }
        : existingClip,
    ),
  };

  const request = await buildBridgeTaskRequest({
    workspaceId,
    sessionId,
    target,
    intent,
    packageMode,
    scope,
    evidenceProfile,
    activeClip: {
      ...clip,
      title: draftTitle,
      note: draftNote,
    },
    session: sessionForBundle,
    draftTitle,
    draftNote,
  });

  const acceptedTask = await createBridgeTask(request);
  const pendingTask = createPendingTask(acceptedTask, request);

  const finalTask =
    acceptedTask.delivery.state === 'queued' || acceptedTask.delivery.state === 'delivering'
      ? await waitForBridgeTask(acceptedTask.taskId, {
          onUpdate: () => undefined,
        })
      : pendingTask;

  const updatedSession = await updateClipHandoff(
    clipId,
    buildHandoffRecord({
      task: finalTask,
      workspaceName,
      sessionLabel: finalTask.delivery.sessionId ? sessionLabel : null,
      packageMode,
    }),
  );

  return {
    session: updatedSession,
    task: finalTask,
  };
}
