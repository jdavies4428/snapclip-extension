import type { SnapClipMessage, SnapClipMessageResponse } from '../shared/messaging/messages';
import { STORAGE_KEYS } from '../shared/snapshot/storage';
import { startClipWorkflow } from './clipping';
import { ensureSupportedWindow, getActiveTab } from './permissions';
import { commitClipToSession, exportClipSession, getOrCreateSession } from './session';
import { getClipSession, updateClipAnnotations, updateClipNote, updateClipTitle } from './storage';

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
      const session = await commitClipToSession(message);
      return { ok: true, session };
    }
    case 'get-clip-session': {
      const session = await getOrCreateSession();
      return { ok: true, session };
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
