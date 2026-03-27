import { getClipAssetBlob } from '../shared/storage/blob-store';
import { saveDelivery } from '../shared/integrations/delivery';
import type { IntegrationTarget } from '../shared/integrations/types';
import type { ClipRecord, ClipSession } from '../shared/types/session';
import type { SendIntegrationClipMessage } from '../shared/messaging/messages';
import { updateClipDraft, getClipSession, getStoredClipRecord } from './storage';
import { sendClipToDiscord } from '../shared/integrations/discord/send';
import { createIssueWithScreenshot } from '../shared/integrations/jira/send';
import { createIssueWithComment } from '../shared/integrations/linear/send';
import { sendClipToSlack } from '../shared/integrations/slack/send';
import { postTeamsMessage } from '../shared/integrations/teams/send';

async function resolveSavedClipForSend(
  clipId?: string,
): Promise<{ session: ClipSession; clip: ClipRecord; clipId: string }> {
  const session = await getClipSession();
  if (!session) {
    throw new Error('Capture a clip first before sending it.');
  }

  const resolvedClipId = clipId?.trim() || session.activeClipId || session.clips.at(-1)?.id || '';
  if (!resolvedClipId) {
    throw new Error('Capture a clip first before sending it.');
  }

  const clip = await getStoredClipRecord(resolvedClipId);
  if (!clip) {
    throw new Error('The current clip is no longer available.');
  }

  return { session, clip, clipId: resolvedClipId };
}

async function persistClipDraftForSend(
  params: SendIntegrationClipMessage,
): Promise<{ session: ClipSession; clip: ClipRecord; clipId: string }> {
  const saved = await resolveSavedClipForSend(params.clipId);
  await updateClipDraft(saved.clipId, {
    title: params.draftTitle?.trim() || saved.clip.title,
    note: params.draftNote ?? saved.clip.note,
  });

  const session = await getClipSession();
  const clip = await getStoredClipRecord(saved.clipId);
  if (!session || !clip) {
    throw new Error('The updated clip could not be reloaded for delivery.');
  }

  return {
    session,
    clip,
    clipId: saved.clipId,
  };
}

async function dispatchToTarget(params: {
  target: IntegrationTarget;
  clip: ClipRecord;
  imageBlob: Blob;
}): Promise<{ externalUrl?: string }> {
  switch (params.target) {
    case 'discord':
      return sendClipToDiscord(params);
    case 'jira':
      return createIssueWithScreenshot(params);
    case 'linear': {
      const imageDataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(reader.error ?? new Error('Failed to encode the screenshot for Linear.'));
        reader.readAsDataURL(params.imageBlob);
      });
      return createIssueWithComment({
        clip: params.clip,
        imageDataUrl,
      });
    }
    case 'slack':
      return sendClipToSlack(params);
    case 'teams':
      return postTeamsMessage(params);
    default:
      throw new Error('Unsupported integration target.');
  }
}

export async function sendClipToIntegration(
  params: SendIntegrationClipMessage,
): Promise<{ session: ClipSession }> {
  const target = params.target;
  const { session, clip, clipId } = await persistClipDraftForSend(params);
  const imageBlob = await getClipAssetBlob(clip.imageAssetId);
  if (!imageBlob) {
    throw new Error('The saved screenshot could not be loaded.');
  }

  await saveDelivery({
    clipId,
    target,
    status: 'sending',
  });

  try {
    const result = await dispatchToTarget({
      target,
      clip,
      imageBlob,
    });

    await saveDelivery({
      clipId,
      target,
      status: 'sent',
      externalUrl: result.externalUrl,
      sentAt: new Date().toISOString(),
    });
  } catch (error) {
    await saveDelivery({
      clipId,
      target,
      status: 'failed',
      error: error instanceof Error ? error.message : 'The integration send failed.',
    });
    throw error;
  }

  return { session };
}
