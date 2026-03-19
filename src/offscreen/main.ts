import type { SnapClipMessage, SnapClipMessageResponse } from '../shared/messaging/messages';

async function copyTextWithFallback(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.append(textarea);
    textarea.focus();
    textarea.select();
    const success = document.execCommand('copy');
    textarea.remove();

    if (!success) {
      throw new Error('Clipboard copy failed.');
    }
  }
}

async function copyImageWithFallback(dataUrl: string): Promise<void> {
  const blob = await fetch(dataUrl).then(async (response) => response.blob());

  if ('ClipboardItem' in window && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': blob,
        }),
      ]);
      return;
    } catch {
      // Fall back to execCommand copy below.
    }
  }

  const wrapper = document.createElement('div');
  wrapper.contentEditable = 'true';
  wrapper.style.position = 'fixed';
  wrapper.style.opacity = '0';
  wrapper.style.pointerEvents = 'none';

  const image = document.createElement('img');
  image.src = dataUrl;
  wrapper.append(image);
  document.body.append(wrapper);

  const range = document.createRange();
  range.selectNode(image);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  const success = document.execCommand('copy');
  selection?.removeAllRanges();
  wrapper.remove();

  if (!success) {
    throw new Error('Image copy failed in this browser context.');
  }
}

chrome.runtime.onMessage.addListener((message: SnapClipMessage, _sender, sendResponse) => {
  if (message.type === 'offscreen-copy-text') {
    void copyTextWithFallback(message.text)
      .then(() => sendResponse({ ok: true } satisfies SnapClipMessageResponse))
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : 'Clipboard copy failed.';
        sendResponse({ ok: false, error: errorMessage } satisfies SnapClipMessageResponse);
      });
    return true;
  }

  if (message.type === 'offscreen-copy-image') {
    void copyImageWithFallback(message.dataUrl)
      .then(() => sendResponse({ ok: true } satisfies SnapClipMessageResponse))
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : 'Image copy failed.';
        sendResponse({ ok: false, error: errorMessage } satisfies SnapClipMessageResponse);
      });
    return true;
  }

  return false;
});
