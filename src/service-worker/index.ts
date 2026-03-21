import type { SnapClipMessage, SnapClipMessageResponse } from '../shared/messaging/messages';
import { STORAGE_KEYS } from '../shared/snapshot/storage';
import { startClipWorkflow } from './clipping';
import { getSupportedActiveTab } from './permissions';
import { routeMessage } from './router';

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
      });
    }

    if (command === 'start-visible-clip') {
      await startClipWorkflow('visible', {
        tabId: tab.id,
        windowId: tab.windowId,
      });
    }
  } catch (error) {
    console.error('Failed to handle command', error);
    await chrome.storage.local.set({
      [STORAGE_KEYS.lastLaunchError]:
        error instanceof Error ? error.message : 'Failed to start clipping from the keyboard shortcut.',
    });
  }
});

chrome.runtime.onMessage.addListener((message: SnapClipMessage, _sender, sendResponse) => {
  if (
    message.type === 'offscreen-copy-text' ||
    message.type === 'offscreen-copy-image'
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
