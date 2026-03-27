import type { SnapClipMessage, SnapClipMessageResponse } from '../shared/messaging/messages';
import { STORAGE_KEYS } from '../shared/snapshot/storage';
import { openSavedClipEditor, startClipWorkflow } from './clipping';
import { ensureSupportedWindow, getActiveTab, getSupportedActiveTab } from './permissions';
import { routeMessage } from './router';
import { getClipSession, getStoredClipRecord } from './storage';

function normalizeLaunchError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Failed to start clipping.';

  if (message.includes('site access request')) {
    return message;
  }

  if (message.includes('Grant site access')) {
    return message;
  }

  if (message.includes('Extension manifest must request permission to access this host')) {
    return 'LLM Clip needs access to this site before it can clip. Approve the site access request and try again.';
  }

  return message;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch((error) => console.error('Failed to set side panel behavior', error));
});

async function openSidePanelForLastFocusedWindow() {
  const targetTab = await getActiveTab();

  if (typeof targetTab?.id === 'number') {
    await chrome.sidePanel.open({ tabId: targetTab.id });
    return;
  }

  if (typeof targetTab?.windowId === 'number') {
    await chrome.sidePanel.open({ windowId: ensureSupportedWindow(targetTab.windowId) });
    return;
  }

  throw new Error('No active browser window was found.');
}

async function openLastCapturedClipEditor() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.lastCapturedClipId,
  ]);
  let clipId = result[STORAGE_KEYS.lastCapturedClipId];

  if (typeof clipId !== 'string' || !clipId.trim()) {
    const session = await getClipSession();
    clipId = session?.activeClipId ?? session?.clips.at(-1)?.id ?? '';

    if (clipId) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.lastCapturedClipId]: clipId,
      });
    }
  }

  if (typeof clipId !== 'string' || !clipId.trim()) {
    throw new Error('Capture a clip first, then use the edit shortcut.');
  }

  const clip = await getStoredClipRecord(clipId);
  if (!clip) {
    throw new Error('The latest saved clip is no longer available.');
  }

  await openSavedClipEditor(clip, {
    interactive: true,
  });
}

// chrome.commands.onCommand passes an optional tab as the second arg in
// newer Chrome builds, but @types/chrome omits it — cast to access it.
type CommandListener = (command: string, tab?: chrome.tabs.Tab) => void;
(chrome.commands.onCommand as chrome.events.Event<CommandListener>).addListener(async (command, commandTab) => {
  try {
    if (command === 'open-side-panel') {
      // Use the tab passed directly by the command event to avoid async
      // getActiveTab() breaking the user gesture context in MV3.
      if (typeof commandTab?.id === 'number') {
        await chrome.sidePanel.open({ tabId: commandTab.id });
      } else if (typeof commandTab?.windowId === 'number') {
        await chrome.sidePanel.open({ windowId: commandTab.windowId });
      } else {
        await openSidePanelForLastFocusedWindow();
      }
      return;
    }

    await chrome.storage.local.remove(STORAGE_KEYS.lastLaunchError);

    if (command === 'open-last-clip-editor') {
      await openLastCapturedClipEditor();
      return;
    }

    const tab = await getSupportedActiveTab();

    if (command === 'start-region-clip') {
      await startClipWorkflow('region', {
        tabId: tab.id,
        windowId: tab.windowId,
        interactive: true,
        launchMode: 'quick-copy',
      });
    }

    if (command === 'start-visible-clip') {
      await startClipWorkflow('visible', {
        tabId: tab.id,
        windowId: tab.windowId,
        interactive: true,
        launchMode: 'quick-copy',
      });
    }
  } catch (error) {
    console.error('Failed to handle command', error);
    const errorMessage = normalizeLaunchError(error);
    if (command !== 'open-side-panel') {
      await chrome.storage.local.set({
        [STORAGE_KEYS.lastLaunchError]: errorMessage,
      });
      try {
        await openSidePanelForLastFocusedWindow();
      } catch {
        // Ignore if the side panel cannot be opened here.
      }
    }
  }
});

chrome.runtime.onMessage.addListener((message: SnapClipMessage, _sender, sendResponse) => {
  if (
    message.type === 'offscreen-copy-text' ||
    message.type === 'offscreen-copy-image' ||
    message.type === 'offscreen-copy-packet'
  ) {
    return false;
  }

  routeMessage(message)
    .then((response: SnapClipMessageResponse) => sendResponse(response))
    .catch((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : 'Unexpected error';
      sendResponse({ ok: false, error: errorMessage });
    });

  return true;
});
