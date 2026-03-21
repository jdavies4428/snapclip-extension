(function () {
  async function copyTextWithFallback(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (_error) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
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

  async function copyImageWithFallback(dataUrl) {
    const blob = await fetch(dataUrl).then(function (response) {
      return response.blob();
    });
    const html = `<img src="${dataUrl}" alt="LLM Clip capture" />`;
    const plainText = 'LLM Clip image copied.';

    if ('ClipboardItem' in window && navigator.clipboard && navigator.clipboard.write) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            'image/png': blob,
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([plainText], { type: 'text/plain' }),
          }),
        ]);
        return;
      } catch (_error) {
        // Fall through to execCommand-based fallback.
      }
    }

    const wrapper = document.createElement('div');
    wrapper.contentEditable = 'true';
    wrapper.style.position = 'fixed';
    wrapper.style.opacity = '0';
    wrapper.style.pointerEvents = 'none';
    wrapper.style.left = '-9999px';
    wrapper.style.top = '0';

    const image = document.createElement('img');
    image.src = dataUrl;
    try {
      await image.decode();
    } catch (_error) {
      // Ignore decode failures and let copy attempt continue.
    }
    wrapper.append(image);
    document.body.append(wrapper);
    wrapper.focus();

    const range = document.createRange();
    range.selectNodeContents(wrapper);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const success = document.execCommand('copy');
    if (selection) {
      selection.removeAllRanges();
    }
    wrapper.remove();

    if (!success) {
      throw new Error('Image copy failed in this browser context.');
    }
  }

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message.type === 'offscreen-copy-text') {
      copyTextWithFallback(message.text)
        .then(function () {
          sendResponse({ ok: true });
        })
        .catch(function (error) {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Clipboard copy failed.',
          });
        });
      return true;
    }

    if (message.type === 'offscreen-copy-image') {
      copyImageWithFallback(message.dataUrl)
        .then(function () {
          sendResponse({ ok: true });
        })
        .catch(function (error) {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Image copy failed.',
          });
        });
      return true;
    }

    return false;
  });
})();
