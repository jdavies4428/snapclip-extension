import type { SnapClipMessage, SnapClipMessageResponse } from '../shared/messaging/messages';
import { STORAGE_KEYS } from '../shared/snapshot/storage';
import { cancelClipOverlay, openSavedClipEditor, startClipWorkflow } from './clipping';
import { loadBridgeSessions, loadBridgeWorkspaces, sendClipToClaudeSession } from './bridge-handoff';
import { ensureSupportedWindow, getActiveTab } from './permissions';
import { commitClipToSession, exportClipSession, getOrCreateSession } from './session';
import { getClipSession, getStoredClipRecord, updateClipAnnotations, updateClipHandoff, updateClipNote, updateClipTitle } from './storage';

async function openSidePanelForActiveWindow(): Promise<void> {
  const tab = await getActiveTab();
  await chrome.sidePanel.open({ windowId: ensureSupportedWindow(tab.windowId) });
}

function normalizeLaunchError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Failed to start clipping.';

  if (message.includes('Extension manifest must request permission to access this host')) {
    return 'LLM Clip needs access to this site before it can clip from the side panel. Approve the site access prompt and try again.';
  }

  return message;
}

function normalizeBridgeMessageError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function routeMessage(message: SnapClipMessage): Promise<SnapClipMessageResponse> {
  switch (message.type) {
    case 'open-side-panel': {
      await openSidePanelForActiveWindow();
      return { ok: true };
    }
    case 'start-clip-workflow': {
      try {
        await chrome.storage.local.remove(STORAGE_KEYS.lastLaunchError);
        await startClipWorkflow(message.clipMode, {
          tabId: message.tabId,
          windowId: message.windowId,
          interactive: true,
        });
        return { ok: true };
      } catch (error) {
        const errorMessage = normalizeLaunchError(error);
        await chrome.storage.local.set({
          [STORAGE_KEYS.lastLaunchError]: errorMessage,
        });
        return { ok: false, error: errorMessage };
      }
    }
    case 'open-clip-editor': {
      try {
        await chrome.storage.local.remove(STORAGE_KEYS.lastLaunchError);
        const session = await getClipSession();
        const fallbackClipId = session?.activeClipId ?? session?.clips.at(-1)?.id ?? null;
        const clipId = message.clipId ?? fallbackClipId;

        if (!clipId) {
          return { ok: false, error: 'Capture a clip first, then open the editor.' };
        }

        const clip = await getStoredClipRecord(clipId);
        if (!clip) {
          return { ok: false, error: 'That saved clip is no longer available.' };
        }

        await chrome.storage.local.set({
          [STORAGE_KEYS.lastCapturedClipId]: clip.id,
        });

        await openSavedClipEditor(clip, {
          interactive: true,
        });
        return { ok: true };
      } catch (error) {
        const errorMessage = normalizeLaunchError(error);
        await chrome.storage.local.set({
          [STORAGE_KEYS.lastLaunchError]: errorMessage,
        });
        return { ok: false, error: errorMessage };
      }
    }
    case 'commit-clip': {
      await commitClipToSession(message);
      return { ok: true };
    }
    case 'cancel-clip-overlay': {
      await cancelClipOverlay(message.tabId);
      return { ok: true };
    }
    case 'get-clip-session': {
      const session = await getOrCreateSession();
      return { ok: true, session };
    }
    case 'get-bridge-workspaces': {
      try {
        const workspaces = await loadBridgeWorkspaces();
        return { ok: true, workspaces };
      } catch (error) {
        return { ok: false, error: normalizeBridgeMessageError(error, 'The local bridge workspaces could not be loaded.') };
      }
    }
    case 'get-bridge-sessions': {
      try {
        const sessions = await loadBridgeSessions(message.workspaceId);
        return { ok: true, sessions };
      } catch (error) {
        return { ok: false, error: normalizeBridgeMessageError(error, 'The local bridge sessions could not be loaded.') };
      }
    }
    case 'update-clip-note': {
      const session = await updateClipNote(message.clipId, message.note);
      return { ok: true, session };
    }
    case 'update-clip-title': {
      const session = await updateClipTitle(message.clipId, message.title);
      return { ok: true, session };
    }
    case 'update-clip-annotations': {
      const session = await updateClipAnnotations(message.clipId, message.annotations);
      return { ok: true, session };
    }
    case 'update-clip-handoff': {
      const session = await updateClipHandoff(message.clipId, message.handoff);
      return { ok: true, session };
    }
    case 'send-bridge-claude-session': {
      try {
        const result = await sendClipToClaudeSession(message);
        return { ok: true, session: result.session, task: result.task };
      } catch (error) {
        const errorMessage = normalizeBridgeMessageError(error, 'The local Claude session handoff failed.');
        await chrome.storage.local.set({
          [STORAGE_KEYS.lastLaunchError]: errorMessage,
        });
        return { ok: false, error: errorMessage };
      }
    }
    case 'export-clip-session': {
      const session = await getClipSession();
      if (!session) {
        return { ok: false, error: 'No clip session exists yet.' };
      }
      await exportClipSession(session, message.format);
      return { ok: true, session };
    }
    default: {
      return { ok: false, error: 'Unknown message type.' };
    }
  }
}
