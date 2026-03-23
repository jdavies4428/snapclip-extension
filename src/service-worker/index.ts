import type { SnapClipMessage, SnapClipMessageResponse } from '../shared/messaging/messages';
import { STORAGE_KEYS } from '../shared/snapshot/storage';
import { startClipWorkflow } from './clipping';
import { getSupportedActiveTab } from './permissions';
import { routeMessage } from './router';

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

chrome.commands.onCommand.addListener(async (command) => {
  try {
    const tab = await getSupportedActiveTab();
    await chrome.storage.local.remove(STORAGE_KEYS.lastLaunchError);

    if (command === 'start-region-clip') {
      await startClipWorkflow('region', {
        tabId: tab.id,
        windowId: tab.windowId,
        interactive: true,
      });
    }

    if (command === 'start-visible-clip') {
      await startClipWorkflow('visible', {
        tabId: tab.id,
        windowId: tab.windowId,
        interactive: true,
      });
    }
  } catch (error) {
    console.error('Failed to handle command', error);
    const errorMessage = normalizeLaunchError(error);
    await chrome.storage.local.set({
      [STORAGE_KEYS.lastLaunchError]: errorMessage,
    });
    try {
      const tab = await getSupportedActiveTab();
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch {
      // Ignore if the side panel cannot be opened here.
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
