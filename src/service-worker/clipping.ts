import { collectPageContext } from '../content-script';
import { getClipAssetBlob } from '../shared/storage/blob-store';
import type { ClipAnnotation, ClipMode, ClipRecord, ClipRect, RuntimeContext } from '../shared/types/session';
import type { PageContext } from '../shared/types/snapshot';
import { pageContextSchema } from '../shared/types/snapshot';
import { captureChromeDebuggerContext } from './debugger';
import {
  ensureSupportedWindow,
  getSupportedActiveTab,
  getSupportedTabById,
  getUrlHostLabel,
  isHostAccessError,
  requestTabHostAccess,
} from './permissions';
import { captureRuntimeContext, ensureRuntimeMonitor } from './runtime';

type ExistingClipEditorState = {
  clipId: string;
  title: string;
  note: string;
  annotations: ClipAnnotation[];
  crop: ClipRect;
};

type ClipLaunchMode = 'editor' | 'quick-copy' | 'saved-editor';

function mountClipOverlay(
  clipMode: ClipMode,
  screenshotDataUrl: string,
  pageContext: PageContext,
  runtimeContext: RuntimeContext | null,
  launchMode: ClipLaunchMode,
  existingClip: ExistingClipEditorState | null,
) {
  const overlayId = 'snapclip-overlay-root';
  const cancelOverlayKey = '__llmClipCancelOverlay';
  const bridgeSelectedWorkspaceStorageKey = 'snapclip.bridge.selectedWorkspaceId';
  const bridgeSelectedSessionStorageKey = 'snapclip.bridge.selectedSessionId';

  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);
  const pickWorkspaceId = (
    workspaces: Array<{ id: string; sessionCount?: number }>,
    currentValue: string,
  ) => {
    if (currentValue && workspaces.some((workspace) => workspace.id === currentValue)) {
      return currentValue;
    }

    const withSessions = workspaces.find((workspace) => (workspace.sessionCount ?? 0) > 0);
    return withSessions?.id ?? workspaces[0]?.id ?? '';
  };
  const pickSessionId = (sessions: Array<{ id: string }>, currentValue: string) => {
    if (currentValue && sessions.some((session) => session.id === currentValue)) {
      return currentValue;
    }

    return sessions.length === 1 ? sessions[0]?.id ?? '' : '';
  };

  const removeOverlay = () => {
    document.getElementById(overlayId)?.remove();
  };

  let hoverCardNode: HTMLDivElement | null = null;

  const teardownOverlay = () => {
    window.removeEventListener('keydown', handleEscape, true);
    delete (window as typeof window & { [cancelOverlayKey]?: () => void })[cancelOverlayKey];
    hoverCardNode?.remove();
    hoverCardNode = null;
    removeOverlay();
  };

  const cropImageDataUrl = async (crop: ClipRect): Promise<string> => {
    const image = new Image();
    image.src = screenshotDataUrl;
    await image.decode();

    const scaleX = image.naturalWidth / window.innerWidth;
    const scaleY = image.naturalHeight / window.innerHeight;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(crop.width * scaleX));
    canvas.height = Math.max(1, Math.round(crop.height * scaleY));

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas context was unavailable for clip cropping.');
    }

    context.drawImage(
      image,
      Math.round(crop.x * scaleX),
      Math.round(crop.y * scaleY),
      Math.round(crop.width * scaleX),
      Math.round(crop.height * scaleY),
      0,
      0,
      canvas.width,
      canvas.height,
    );

    return canvas.toDataURL('image/png');
  };

  const ensureOffscreenDocument = async () => {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen/index.html',
        reasons: ['CLIPBOARD'],
        justification: 'Copy clip images and packet summaries from the capture overlay.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Only a single offscreen document may be created')) {
        throw error;
      }
    }
  };

  const copyTextDirectly = async (text: string) => {
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
  };

  const copyImageDirectly = async (dataUrl: string) => {
    const blob = await fetch(dataUrl).then(async (response) => response.blob());
    const html = `<img src="${dataUrl}" alt="LLM Clip capture" />`;
    const plainText = 'LLM Clip image copied.';

    if ('ClipboardItem' in window && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': blob,
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
        }),
      ]);
      return;
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
    await image.decode().catch(() => undefined);
    wrapper.append(image);
    document.body.append(wrapper);
    wrapper.focus();

    const range = document.createRange();
    range.selectNodeContents(wrapper);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const success = document.execCommand('copy');
    selection?.removeAllRanges();
    wrapper.remove();

    if (!success) {
      throw new Error('Image copy failed in this browser context.');
    }
  };

  const copyPacketDirectly = async (dataUrl: string, text: string) => {
    const blob = await fetch(dataUrl).then(async (response) => response.blob());
    const html = [
      '<div>',
      `<p><img src="${dataUrl}" alt="LLM Clip capture" /></p>`,
      `<pre style="white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">${text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')}</pre>`,
      '</div>',
    ].join('');

    if ('ClipboardItem' in window && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': blob,
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return;
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
    await image.decode().catch(() => undefined);
    wrapper.append(image);

    const pre = document.createElement('pre');
    pre.textContent = text;
    pre.style.whiteSpace = 'pre-wrap';
    wrapper.append(pre);

    document.body.append(wrapper);
    wrapper.focus();

    const range = document.createRange();
    range.selectNodeContents(wrapper);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const success = document.execCommand('copy');
    selection?.removeAllRanges();
    wrapper.remove();

    if (!success) {
      throw new Error('Packet copy failed in this browser context.');
    }
  };

  const copyTextToClipboard = async (text: string) => {
    try {
      await copyTextDirectly(text);
      return;
    } catch {
      await ensureOffscreenDocument();
      const response = await chrome.runtime.sendMessage({
        type: 'offscreen-copy-text',
        text,
      });

      if (!response?.ok) {
        throw new Error(response?.error || 'Clipboard copy failed.');
      }
    }
  };

  const copyImageToClipboard = async (dataUrl: string) => {
    try {
      await copyImageDirectly(dataUrl);
      return;
    } catch {
      await ensureOffscreenDocument();
      const response = await chrome.runtime.sendMessage({
        type: 'offscreen-copy-image',
        dataUrl,
      });

      if (!response?.ok) {
        throw new Error(response?.error || 'Image copy failed in this browser context.');
      }
    }
  };

  const copyPacketToClipboard = async (dataUrl: string, text: string) => {
    try {
      await copyPacketDirectly(dataUrl, text);
      return;
    } catch {
      await ensureOffscreenDocument();
      const response = await chrome.runtime.sendMessage({
        type: 'offscreen-copy-packet',
        dataUrl,
        text,
      });

      if (!response?.ok) {
        throw new Error(response?.error || 'Packet copy failed in this browser context.');
      }
    }
  };

  const flashButtonState = (
    button: HTMLButtonElement,
    idleLabel: string,
    activeLabel: string,
    work: () => Promise<void>,
  ) => {
    button.disabled = true;
    button.textContent = activeLabel;
    return work()
      .then(() => {
        button.textContent = 'Copied';
        window.setTimeout(() => {
          button.disabled = false;
          button.textContent = idleLabel;
        }, 1400);
      })
      .catch((error) => {
        button.disabled = false;
        button.textContent = idleLabel;
        throw error;
      });
  };

  const buildAutomaticClipTitle = (pageUrl: string, capturedAt = new Date()) => {
    let host = 'clip';
    try {
      host = new URL(pageUrl).hostname.replace(/^www\./, '') || 'clip';
    } catch {
      // Fall back to a generic title if the URL cannot be parsed.
    }

    const dateParts = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(capturedAt);

    const getPart = (type: Intl.DateTimeFormatPartTypes) =>
      dateParts.find((entry) => entry.type === type)?.value ?? '00';

    return `${host}_${getPart('year')}-${getPart('month')}-${getPart('day')}_${getPart('hour')}-${getPart('minute')}`;
  };

  const normalizeRect = (
    startX: number,
    startY: number,
    currentX: number,
    currentY: number,
  ): ClipRect => ({
    x: Math.round(Math.min(startX, currentX)),
    y: Math.round(Math.min(startY, currentY)),
    width: Math.round(Math.abs(currentX - startX)),
    height: Math.round(Math.abs(currentY - startY)),
  });

  removeOverlay();

  const root = document.createElement('div');
  root.id = overlayId;
  root.style.position = 'fixed';
  root.style.inset = '0';
  root.style.zIndex = '2147483646';
  root.style.cursor = clipMode === 'region' ? 'none' : 'default';
  root.style.background = 'transparent';

  const topMask = document.createElement('div');
  const leftMask = document.createElement('div');
  const rightMask = document.createElement('div');
  const bottomMask = document.createElement('div');
  const masks = [topMask, leftMask, rightMask, bottomMask];

  masks.forEach((mask) => {
    mask.style.position = 'fixed';
    mask.style.background = 'rgba(6, 12, 24, 0.18)';
    mask.style.backdropFilter = 'blur(1.5px)';
    mask.style.pointerEvents = 'none';
    mask.style.opacity = '0';
    mask.style.transition = 'opacity 120ms ease';
    root.append(mask);
  });

  const selection = document.createElement('div');
  selection.style.position = 'fixed';
  selection.style.border = '2px solid #67c9ff';
  selection.style.background = 'rgba(103, 201, 255, 0.08)';
  selection.style.borderRadius = '12px';
  selection.style.pointerEvents = 'none';
  selection.style.display = clipMode === 'visible' && launchMode === 'editor' ? 'block' : 'none';
  selection.style.boxShadow = '0 18px 60px rgba(103, 201, 255, 0.14)';
  root.append(selection);

  const cornerStyle = (node: HTMLDivElement) => {
    node.style.position = 'absolute';
    node.style.width = '18px';
    node.style.height = '18px';
    node.style.borderColor = '#8fe0ff';
    node.style.borderStyle = 'solid';
    node.style.pointerEvents = 'none';
  };

  const topLeftCorner = document.createElement('div');
  cornerStyle(topLeftCorner);
  topLeftCorner.style.left = '-2px';
  topLeftCorner.style.top = '-2px';
  topLeftCorner.style.borderWidth = '3px 0 0 3px';

  const topRightCorner = document.createElement('div');
  cornerStyle(topRightCorner);
  topRightCorner.style.right = '-2px';
  topRightCorner.style.top = '-2px';
  topRightCorner.style.borderWidth = '3px 3px 0 0';

  const bottomLeftCorner = document.createElement('div');
  cornerStyle(bottomLeftCorner);
  bottomLeftCorner.style.left = '-2px';
  bottomLeftCorner.style.bottom = '-2px';
  bottomLeftCorner.style.borderWidth = '0 0 3px 3px';

  const bottomRightCorner = document.createElement('div');
  cornerStyle(bottomRightCorner);
  bottomRightCorner.style.right = '-2px';
  bottomRightCorner.style.bottom = '-2px';
  bottomRightCorner.style.borderWidth = '0 3px 3px 0';

  selection.append(topLeftCorner, topRightCorner, bottomLeftCorner, bottomRightCorner);

  const hint = document.createElement('div');
  hint.style.position = 'fixed';
  hint.style.top = '24px';
  hint.style.left = '50%';
  hint.style.transform = 'translateX(-50%)';
  hint.style.padding = '12px 16px';
  hint.style.borderRadius = '999px';
  hint.style.background = 'rgba(8, 15, 28, 0.96)';
  hint.style.border = '1px solid rgba(115, 187, 255, 0.35)';
  hint.style.boxShadow = '0 18px 50px rgba(0, 0, 0, 0.35)';
  hint.style.color = '#e7edf7';
  hint.style.fontFamily = '"SF Pro Display", "Segoe UI", sans-serif';
  hint.style.fontSize = '14px';
  hint.style.fontWeight = '600';
  hint.style.zIndex = '2147483647';
  hint.textContent =
    launchMode === 'saved-editor'
      ? 'Opening the saved clip editor...'
      : clipMode === 'visible'
      ? launchMode === 'quick-copy'
        ? 'Copying the visible tab...'
        : 'Preparing the visible tab editor...'
      : launchMode === 'quick-copy'
        ? 'Drag to select. Release to copy. Press Esc to cancel.'
        : 'Drag to select. Release to capture. Press Esc to cancel.';
  root.append(hint);

  const cursorBubble = document.createElement('div');
  cursorBubble.style.position = 'fixed';
  cursorBubble.style.left = '0';
  cursorBubble.style.top = '0';
  cursorBubble.style.display = 'none';
  cursorBubble.style.alignItems = 'center';
  cursorBubble.style.gap = '8px';
  cursorBubble.style.fontFamily = '"Avenir Next", "SF Pro Display", "Segoe UI", sans-serif';
  cursorBubble.style.fontSize = '12px';
  cursorBubble.style.fontWeight = '700';
  cursorBubble.style.letterSpacing = '0.04em';
  cursorBubble.style.pointerEvents = 'none';
  cursorBubble.style.transform = 'translate3d(-9999px, -9999px, 0)';
  cursorBubble.style.zIndex = '2147483647';

  const cursorDot = document.createElement('div');
  cursorDot.style.width = '22px';
  cursorDot.style.height = '22px';
  cursorDot.style.display = 'grid';
  cursorDot.style.placeItems = 'center';
  cursorDot.style.flex = '0 0 auto';
  cursorDot.style.filter = 'drop-shadow(0 10px 20px rgba(0, 0, 0, 0.38))';
  cursorDot.innerHTML = `
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M4.5 3.5L16.8 11.1L11.1 12.4L13.4 18.5L10.8 19.5L8.5 13.5L4.5 17.4V3.5Z" fill="#F4FAFF"/>
      <path d="M4.5 3.5L16.8 11.1L11.1 12.4L13.4 18.5L10.8 19.5L8.5 13.5L4.5 17.4V3.5Z" stroke="#0A1627" stroke-width="1.35" stroke-linejoin="round"/>
      <path d="M4.5 3.5L16.8 11.1L11.1 12.4" stroke="#66C7FF" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;

  const cursorText = document.createElement('div');
  cursorText.textContent = '';
  cursorText.style.whiteSpace = 'nowrap';
  cursorText.style.display = 'none';
  cursorText.style.padding = '6px 10px';
  cursorText.style.borderRadius = '999px';
  cursorText.style.background = 'rgba(9, 14, 24, 0.9)';
  cursorText.style.border = '1px solid rgba(115, 187, 255, 0.24)';
  cursorText.style.boxShadow = '0 14px 36px rgba(0, 0, 0, 0.28)';
  cursorText.style.color = '#eef4fb';

  cursorBubble.append(cursorDot, cursorText);
  root.append(cursorBubble);

  const moveCursorBubble = (clientX: number, clientY: number) => {
    const offsetX = 10;
    const offsetY = 8;
    const maxX = Math.max(16, window.innerWidth - 220);
    const maxY = Math.max(16, window.innerHeight - 72);
    const nextX = clamp(clientX + offsetX, 16, maxX);
    const nextY = clamp(clientY + offsetY, 16, maxY);
    cursorBubble.style.transform = `translate3d(${nextX}px, ${nextY}px, 0)`;
  };

  const showCursorBubble = (label: string, clientX?: number, clientY?: number) => {
    cursorText.textContent = label;
    cursorText.style.display = label ? 'inline-flex' : 'none';
    cursorBubble.style.display = 'inline-flex';
    if (typeof clientX === 'number' && typeof clientY === 'number') {
      moveCursorBubble(clientX, clientY);
    }
  };

  const hideCursorBubble = () => {
    cursorBubble.style.display = 'none';
    cursorBubble.style.transform = 'translate3d(-9999px, -9999px, 0)';
  };

  const setHintTone = (tone: 'default' | 'success' | 'error') => {
    if (tone === 'success') {
      hint.style.background = 'rgba(16, 92, 58, 0.96)';
      hint.style.border = '1px solid rgba(93, 232, 162, 0.42)';
      hint.style.color = '#effff6';
      hint.style.boxShadow = '0 18px 50px rgba(18, 110, 70, 0.28)';
      return;
    }

    if (tone === 'error') {
      hint.style.background = 'rgba(100, 28, 36, 0.96)';
      hint.style.border = '1px solid rgba(255, 126, 145, 0.42)';
      hint.style.color = '#fff1f4';
      hint.style.boxShadow = '0 18px 50px rgba(125, 30, 44, 0.28)';
      return;
    }

    hint.style.background = 'rgba(8, 15, 28, 0.96)';
    hint.style.border = '1px solid rgba(115, 187, 255, 0.35)';
    hint.style.color = '#e7edf7';
    hint.style.boxShadow = '0 18px 50px rgba(0, 0, 0, 0.35)';
  };

  const announce = (
    message: string,
    tone: 'default' | 'success' | 'error' = 'default',
  ) => {
    hint.textContent = message;
    setHintTone(tone);
  };

  let activeRect: ClipRect = {
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  };

  selection.style.left = '0px';
  selection.style.top = '0px';
  selection.style.width = `${activeRect.width}px`;
  selection.style.height = `${activeRect.height}px`;

  let dragStart: { x: number; y: number } | null = null;
  let isSaving = false;
  let phase: 'select' | 'editing' = clipMode === 'region' ? 'select' : 'editing';
  let handleEditorEscape: (() => boolean) | null = null;

  const updateSpotlightMasks = (rect: ClipRect) => {
    if (clipMode !== 'region' || rect.width < 1 || rect.height < 1) {
      masks.forEach((mask) => {
        mask.style.opacity = '0';
      });
      return;
    }

    topMask.style.left = '0px';
    topMask.style.top = '0px';
    topMask.style.width = '100vw';
    topMask.style.height = `${rect.y}px`;

    leftMask.style.left = '0px';
    leftMask.style.top = `${rect.y}px`;
    leftMask.style.width = `${rect.x}px`;
    leftMask.style.height = `${rect.height}px`;

    rightMask.style.left = `${rect.x + rect.width}px`;
    rightMask.style.top = `${rect.y}px`;
    rightMask.style.width = `${Math.max(0, window.innerWidth - rect.x - rect.width)}px`;
    rightMask.style.height = `${rect.height}px`;

    bottomMask.style.left = '0px';
    bottomMask.style.top = `${rect.y + rect.height}px`;
    bottomMask.style.width = '100vw';
    bottomMask.style.height = `${Math.max(0, window.innerHeight - rect.y - rect.height)}px`;

    masks.forEach((mask) => {
      mask.style.opacity = '1';
    });
  };

  const updateSelection = (rect: ClipRect) => {
    activeRect = rect;
    selection.style.display = 'block';
    selection.style.left = `${rect.x}px`;
    selection.style.top = `${rect.y}px`;
    selection.style.width = `${rect.width}px`;
    selection.style.height = `${rect.height}px`;
    updateSpotlightMasks(rect);
  };

  if (clipMode === 'region') {
    root.addEventListener('mouseenter', (event) => {
      if (phase !== 'select') {
        return;
      }
      showCursorBubble('', event.clientX, event.clientY);
    });

    root.addEventListener('mouseleave', () => {
      if (phase === 'select') {
        hideCursorBubble();
      }
    });

    root.addEventListener('mousedown', (event) => {
      if (phase !== 'select') {
        return;
      }
      if ((event.target as HTMLElement).closest('button')) {
        return;
      }

      dragStart = {
        x: clamp(event.clientX, 0, window.innerWidth),
        y: clamp(event.clientY, 0, window.innerHeight),
      };

      updateSelection({
        x: dragStart.x,
        y: dragStart.y,
        width: 0,
        height: 0,
      });
    });

    root.addEventListener('mousemove', (event) => {
      if (phase !== 'select') {
        return;
      }

      moveCursorBubble(event.clientX, event.clientY);

      if (!dragStart) {
        showCursorBubble('', event.clientX, event.clientY);
        return;
      }

      const nextRect = normalizeRect(
        dragStart.x,
        dragStart.y,
        clamp(event.clientX, 0, window.innerWidth),
        clamp(event.clientY, 0, window.innerHeight),
      );
      showCursorBubble(`${nextRect.width} x ${nextRect.height}`, event.clientX, event.clientY);
      updateSelection(
        nextRect,
      );
    });

    root.addEventListener('mouseup', (event) => {
      if (phase !== 'select') {
        return;
      }
      if (!dragStart) {
        return;
      }

      const nextRect = normalizeRect(
        dragStart.x,
        dragStart.y,
        clamp(event.clientX, 0, window.innerWidth),
        clamp(event.clientY, 0, window.innerHeight),
      );
      updateSelection(nextRect);
      dragStart = null;

      if (nextRect.width < 8 || nextRect.height < 8) {
        announce('That area was too small. Drag a larger area or press Esc to cancel.', 'error');
        return;
      }

      if (launchMode === 'quick-copy') {
        void completeQuickCopy(nextRect);
        return;
      }

      void openEditor(nextRect);
    });
  }

  const handleEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') {
      return;
    }

    event.preventDefault();
    if (handleEditorEscape?.()) {
      return;
    }
    teardownOverlay();
  };

  window.addEventListener('keydown', handleEscape, true);
  (window as typeof window & { [cancelOverlayKey]?: () => void })[cancelOverlayKey] = teardownOverlay;

  const persistCapturedClip = async (params: {
    rect: ClipRect;
    clipDataUrl: string;
    imageWidth: number;
    imageHeight: number;
    title: string;
    note?: string;
    annotations?: ClipAnnotation[];
  }) => {
    const response = await chrome.runtime.sendMessage({
      type: 'commit-clip',
      clipMode,
      title: params.title,
      note: params.note ?? '',
      imageDataUrl: params.clipDataUrl,
      imageWidth: params.imageWidth,
      imageHeight: params.imageHeight,
      crop: params.rect,
      pageContext,
      runtimeContext,
      annotations: params.annotations ?? [],
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Clip save failed.');
    }
  };

  const completeQuickCopy = async (rect: ClipRect) => {
    if (isSaving) {
      return;
    }

    isSaving = true;
    phase = 'editing';
    announce(
      clipMode === 'visible' ? 'Copying the visible tab...' : 'Copying the selected area...'
    );

    try {
      const clipDataUrl = await cropImageDataUrl(rect);
      const image = new Image();
      image.src = clipDataUrl;
      await image.decode();

      const clipTitle = buildAutomaticClipTitle(pageContext.url);
      const [copyResult, saveResult] = await Promise.allSettled([
        copyImageToClipboard(clipDataUrl),
        persistCapturedClip({
          rect,
          clipDataUrl,
          imageWidth: image.naturalWidth,
          imageHeight: image.naturalHeight,
          title: clipTitle,
        }),
      ]);

      const copied = copyResult.status === 'fulfilled';
      const saved = saveResult.status === 'fulfilled';
      const copyError = copyResult.status === 'rejected' ? copyResult.reason : null;
      const saveError = saveResult.status === 'rejected' ? saveResult.reason : null;

      if (copied && saved) {
        announce('Image copied. Use the edit shortcut if you want to annotate.', 'success');
      } else if (copied) {
        console.warn('LLM Clip quick-copy save failed after clipboard success.', saveError);
        announce('Image copied. LLM Clip could not save the local draft for editing later.', 'error');
      } else if (saved) {
        console.warn('LLM Clip quick-copy clipboard copy failed; clip saved locally.', copyError);
        announce('Clip saved locally, but clipboard copy was unavailable. Use the edit shortcut or side panel.', 'error');
      } else {
        throw copyError instanceof Error ? copyError : new Error('Clipboard copy failed.');
      }

      window.setTimeout(() => {
        handleEditorEscape = null;
        teardownOverlay();
      }, copied ? 350 : 900);
    } catch (error) {
      announce(
        error instanceof Error ? error.message : 'Quick copy failed.',
        'error',
      );
      isSaving = false;
      phase = clipMode === 'region' ? 'select' : 'editing';
    }
  };

  const openEditor = async (rect: ClipRect, initialClip: ExistingClipEditorState | null = null) => {
    if (isSaving) {
      return;
    }

    isSaving = true;
    phase = 'editing';
    announce(initialClip ? 'Opening the saved clip editor...' : 'Preparing your clip...');

    try {
      const clipDataUrl = initialClip ? screenshotDataUrl : await cropImageDataUrl(rect);
      const image = new Image();
      image.src = clipDataUrl;
      await image.decode();

      root.replaceChildren();
      root.style.cursor = 'default';
      hideCursorBubble();

      const editor = document.createElement('div');
      editor.style.position = 'fixed';
      editor.style.left = '50%';
      editor.style.top = '50%';
      editor.style.transform = 'translate(-50%, -50%)';
      editor.style.width = 'min(98vw, 1840px)';
      editor.style.height = '96vh';
      editor.style.maxWidth = '98vw';
      editor.style.maxHeight = '96vh';
      editor.style.overflow = 'hidden';
      editor.style.boxSizing = 'border-box';
      editor.style.padding = '20px';
      editor.style.borderRadius = '28px';
      editor.style.background =
        'radial-gradient(circle at 0% 0%, rgba(92, 165, 255, 0.14), transparent 24%), radial-gradient(circle at 100% 0%, rgba(255, 138, 91, 0.1), transparent 22%), linear-gradient(180deg, rgba(9, 14, 24, 0.985) 0%, rgba(6, 10, 18, 0.985) 100%)';
      editor.style.border = '1px solid rgba(115, 187, 255, 0.18)';
      editor.style.boxShadow = '0 30px 96px rgba(0, 0, 0, 0.5)';
      editor.style.color = '#eef4fb';
      editor.style.fontFamily = '"Avenir Next", "SF Pro Display", "Segoe UI", sans-serif';
      editor.style.zIndex = '2147483647';
      editor.style.display = 'grid';
      editor.style.gap = '0';
      editor.style.gridTemplateRows = 'minmax(0, 1fr)';
      editor.style.scrollbarWidth = 'none';

      const titleEyebrow = document.createElement('p');
      titleEyebrow.textContent = 'CAPTURE EDITOR';
      titleEyebrow.style.margin = '0';
      titleEyebrow.style.fontSize = '12px';
      titleEyebrow.style.fontWeight = '700';
      titleEyebrow.style.letterSpacing = '0.12em';
      titleEyebrow.style.color = '#b9e7ff';

      const titleHint = document.createElement('span');
      titleHint.textContent = 'Local only';
      titleHint.style.display = 'inline-flex';
      titleHint.style.alignItems = 'center';
      titleHint.style.minHeight = '28px';
      titleHint.style.padding = '0 10px';
      titleHint.style.borderRadius = '999px';
      titleHint.style.background = 'rgba(8, 15, 28, 0.48)';
      titleHint.style.color = '#eef7ff';
      titleHint.style.fontSize = '12px';
      titleHint.style.fontWeight = '700';
      titleHint.style.letterSpacing = '0.04em';

      const closeButton = document.createElement('button');
      closeButton.textContent = 'X';
      closeButton.setAttribute('aria-label', 'Close clip editor');
      closeButton.type = 'button';
      closeButton.style.width = '42px';
      closeButton.style.minWidth = '42px';
      closeButton.style.height = '42px';
      closeButton.style.borderRadius = '999px';
      closeButton.style.border = '0';
      closeButton.style.background = 'rgba(255,255,255,0.08)';
      closeButton.style.color = '#edf3fb';
      closeButton.style.font = 'inherit';
      closeButton.style.fontWeight = '800';
      closeButton.style.cursor = 'pointer';
      closeButton.style.position = 'absolute';
      closeButton.style.top = '18px';
      closeButton.style.right = '18px';
      closeButton.style.zIndex = '2';

      const railHeader = document.createElement('div');
      railHeader.style.display = 'grid';
      railHeader.style.gap = '12px';
      railHeader.style.padding = '16px';
      railHeader.style.borderRadius = '22px';
      railHeader.style.background =
        'linear-gradient(135deg, rgba(83, 197, 255, 0.18) 0%, rgba(59, 130, 255, 0.12) 100%)';
      railHeader.style.border = '1px solid rgba(117, 204, 255, 0.22)';
      railHeader.style.boxShadow = '0 14px 40px rgba(35, 116, 255, 0.14)';

      const titleTopRow = document.createElement('div');
      titleTopRow.style.display = 'flex';
      titleTopRow.style.alignItems = 'center';
      titleTopRow.style.justifyContent = 'space-between';
      titleTopRow.style.gap = '12px';

      const titleControls = document.createElement('div');
      titleControls.style.display = 'flex';
      titleControls.style.alignItems = 'center';
      titleControls.style.gap = '10px';

      const clipTitle = initialClip?.title?.trim() || buildAutomaticClipTitle(pageContext.url);
      let currentClip = initialClip
        ? {
            ...initialClip,
            annotations: initialClip.annotations.map((annotation) => ({ ...annotation })),
          }
        : null;

      const titleSub = document.createElement('p');
      titleSub.textContent = pageContext.title || 'Captured clip';
      titleSub.style.margin = '0';
      titleSub.style.fontSize = '13px';
      titleSub.style.lineHeight = '1.5';
      titleSub.style.color = '#b7c4da';

      titleControls.append(titleHint, closeButton);
      titleTopRow.append(titleEyebrow, titleControls);
      railHeader.append(titleTopRow, titleSub);

      const noteCard = document.createElement('div');
      noteCard.style.display = 'grid';
      noteCard.style.gap = '10px';
      noteCard.style.minHeight = '0';

      const noteLabel = document.createElement('div');
      noteLabel.textContent = 'Agent prompt';
      noteLabel.style.color = '#88d5ff';
      noteLabel.style.fontSize = '12px';
      noteLabel.style.fontWeight = '700';
      noteLabel.style.letterSpacing = '0.08em';
      noteLabel.style.textTransform = 'uppercase';

      const noteHelp = document.createElement('p');
      noteHelp.textContent = 'Say what looks wrong and what you want the model to do next.';
      noteHelp.style.margin = '0';
      noteHelp.style.color = '#b7c4da';
      noteHelp.style.fontSize = '13px';
      noteHelp.style.lineHeight = '1.45';

      const noteField = document.createElement('textarea');
      noteField.placeholder = 'What looks wrong? What should the model do next?';
      noteField.style.width = '100%';
      noteField.style.minHeight = '0';
      noteField.style.height = '100%';
      noteField.style.boxSizing = 'border-box';
      noteField.style.resize = 'none';
      noteField.style.borderRadius = '16px';
      noteField.style.border = '1px solid rgba(103, 209, 255, 0.18)';
      noteField.style.padding = '14px 16px';
      noteField.style.background = 'rgba(255,255,255,0.05)';
      noteField.style.color = '#eef4fb';
      noteField.style.font = 'inherit';
      noteField.style.fontSize = '14px';
      noteField.style.lineHeight = '1.5';
      noteField.style.display = 'block';
      noteField.setAttribute('aria-label', 'Clip instructions');
      noteField.value = currentClip?.note ?? '';

      const claudeRailStrip = document.createElement('div');
      claudeRailStrip.style.display = 'grid';
      claudeRailStrip.style.gap = '10px';
      claudeRailStrip.style.padding = '12px';
      claudeRailStrip.style.borderRadius = '18px';
      claudeRailStrip.style.background = 'rgba(6, 12, 22, 0.76)';
      claudeRailStrip.style.border = '1px solid rgba(103, 209, 255, 0.18)';

      noteCard.append(noteLabel, noteHelp, noteField, claudeRailStrip);

      const actionRow = document.createElement('div');
      actionRow.style.display = 'grid';
      actionRow.style.gap = '10px';

      const actionStatus = document.createElement('div');
      actionStatus.style.display = 'none';
      actionStatus.style.alignItems = 'center';
      actionStatus.style.justifyContent = 'center';
      actionStatus.style.minHeight = '36px';
      actionStatus.style.padding = '0 12px';
      actionStatus.style.borderRadius = '12px';
      actionStatus.style.background = 'rgba(255,255,255,0.06)';
      actionStatus.style.color = '#dbe8f8';
      actionStatus.style.fontSize = '13px';
      actionStatus.style.fontWeight = '700';
      actionStatus.style.lineHeight = '1.35';
      actionStatus.style.textAlign = 'center';
      actionStatus.style.transition = 'background 120ms ease, color 120ms ease';

      const toolRow = document.createElement('div');
      toolRow.style.display = 'grid';
      toolRow.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
      toolRow.style.gap = '8px';

      const toolTextButton = document.createElement('button');
      toolTextButton.textContent = 'Text';
      const toolBoxButton = document.createElement('button');
      toolBoxButton.textContent = 'Box';
      const toolArrowButton = document.createElement('button');
      toolArrowButton.textContent = 'Arrow';
      const toolUndoButton = document.createElement('button');
      toolUndoButton.textContent = 'Undo';

      const copyButton = document.createElement('button');
      copyButton.textContent = 'Copy image';
      const copyInstructionsButton = document.createElement('button');
      copyInstructionsButton.textContent = 'Copy prompt';
      const copySummaryButton = document.createElement('button');
      copySummaryButton.textContent = 'Copy packet';
      const saveButton = document.createElement('button');
      saveButton.textContent = currentClip ? 'Save changes' : 'Save clip';
      const cancelButton = document.createElement('button');
      cancelButton.textContent = 'Discard';
      const detailsButton = document.createElement('button');
      detailsButton.textContent = 'Debug info';

      const hoverCard = document.createElement('div');
      hoverCard.style.position = 'fixed';
      hoverCard.style.zIndex = '2147483647';
      hoverCard.style.maxWidth = '220px';
      hoverCard.style.padding = '10px 12px';
      hoverCard.style.borderRadius = '12px';
      hoverCard.style.background = 'rgba(8, 15, 28, 0.96)';
      hoverCard.style.border = '1px solid rgba(115, 187, 255, 0.28)';
      hoverCard.style.boxShadow = '0 14px 40px rgba(0, 0, 0, 0.35)';
      hoverCard.style.color = '#edf3fb';
      hoverCard.style.fontSize = '12px';
      hoverCard.style.fontWeight = '600';
      hoverCard.style.lineHeight = '1.45';
      hoverCard.style.pointerEvents = 'none';
      hoverCard.style.opacity = '0';
      hoverCard.style.transform = 'translateY(4px)';
      hoverCard.style.transition = 'opacity 120ms ease, transform 120ms ease';
      hoverCard.style.display = 'none';
      document.body.append(hoverCard);
      hoverCardNode = hoverCard;

      let hoverCardTimeout: number | null = null;

      const hideHoverCard = () => {
        if (hoverCardTimeout) {
          window.clearTimeout(hoverCardTimeout);
          hoverCardTimeout = null;
        }
        hoverCard.style.opacity = '0';
        hoverCard.style.transform = 'translateY(4px)';
        hoverCardTimeout = window.setTimeout(() => {
          hoverCard.style.display = 'none';
        }, 120);
      };

      const showHoverCard = (button: HTMLButtonElement, text: string) => {
        if (!text) {
          return;
        }
        if (hoverCardTimeout) {
          window.clearTimeout(hoverCardTimeout);
          hoverCardTimeout = null;
        }
        hoverCard.textContent = text;
        hoverCard.style.display = 'block';
        hoverCard.style.opacity = '0';
        hoverCard.style.transform = 'translateY(4px)';
        const rect = button.getBoundingClientRect();
        const cardWidth = 220;
        const left = clamp(rect.left + rect.width / 2 - cardWidth / 2, 12, window.innerWidth - cardWidth - 12);
        const top = Math.max(12, rect.top - 52);
        hoverCard.style.left = `${left}px`;
        hoverCard.style.top = `${top}px`;
        window.requestAnimationFrame(() => {
          hoverCard.style.opacity = '1';
          hoverCard.style.transform = 'translateY(0)';
        });
      };

      [toolBoxButton, toolTextButton, toolArrowButton, toolUndoButton, copyButton, copyInstructionsButton, copySummaryButton, saveButton, cancelButton, detailsButton].forEach((button) => {
        button.style.border = '0';
        button.style.borderRadius = '14px';
        button.style.padding = '11px 14px';
        button.style.font = 'inherit';
        button.style.fontSize = '13px';
        button.style.fontWeight = '700';
        button.style.lineHeight = '1.2';
        button.style.cursor = 'pointer';
        button.style.background =
          button === saveButton
            ? 'linear-gradient(135deg, #6acfff 0%, #3b82ff 100%)'
            : 'rgba(255,255,255,0.08)';
        button.style.color = button === saveButton ? '#041220' : '#edf3fb';
        button.style.width = '100%';
        button.style.minHeight = '48px';
        button.style.textWrap = 'balance';
      });

      toolUndoButton.title = 'Remove the most recent annotation.';
      copyButton.title = 'Copy the clipped screenshot only.';
      copyInstructionsButton.title = 'Copy just the prompt you wrote for the LLM.';
      copySummaryButton.title = 'Copy the clipped image plus the packet text with prompt and context.';
      detailsButton.title = 'Open the debug inspector for this clip.';

      const hoverButtons: Array<[HTMLButtonElement, string]> = [
        [toolTextButton, 'Add a text note. Double-click an existing text note to edit it.'],
        [toolBoxButton, 'Draw a box around the part that matters.'],
        [toolArrowButton, 'Point at the exact issue or relationship.'],
        [copyButton, 'Copy the clipped screenshot only.'],
        [copyInstructionsButton, 'Copy just your LLM prompt from this clip.'],
        [copySummaryButton, 'Copy the clipped image plus the packet text: prompt, page info, and recent issues.'],
        [saveButton, 'Save this clip locally so it stays in your session gallery.'],
        [cancelButton, 'Close this clip without saving it.'],
      ];

      hoverButtons.forEach(([button, text]) => {
        button.addEventListener('mouseenter', () => showHoverCard(button, text));
        button.addEventListener('mouseleave', hideHoverCard);
        button.addEventListener('focus', () => showHoverCard(button, text));
        button.addEventListener('blur', hideHoverCard);
      });

      const copyRow = document.createElement('div');
      copyRow.style.display = 'grid';
      copyRow.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
      copyRow.style.gap = '8px';

      const saveRow = document.createElement('div');
      saveRow.style.display = 'grid';
      saveRow.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
      saveRow.style.gap = '8px';

      const utilityRow = document.createElement('div');
      utilityRow.style.display = 'grid';
      utilityRow.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
      utilityRow.style.gap = '8px';

      const selectionHint = document.createElement('div');
      selectionHint.style.display = 'block';
      selectionHint.style.minHeight = '34px';
      selectionHint.style.padding = '6px 2px 0';
      selectionHint.style.color = '#9db2cf';
      selectionHint.style.fontSize = '12px';
      selectionHint.style.fontWeight = '600';
      selectionHint.style.lineHeight = '1.45';
      toolRow.append(toolTextButton, toolBoxButton, toolArrowButton);
      copyRow.append(copyButton, copySummaryButton);
      saveRow.append(saveButton, cancelButton);
      utilityRow.append(detailsButton, toolUndoButton);
      actionRow.append(toolRow, selectionHint, saveRow, copyRow, utilityRow, actionStatus);

      const metaRow = document.createElement('div');
      metaRow.style.display = 'flex';
      metaRow.style.gap = '10px';
      metaRow.style.flexWrap = 'wrap';

      const clipModeBadge = document.createElement('div');
      clipModeBadge.textContent = clipMode === 'visible' ? 'Visible tab clip' : 'Area clip';
      clipModeBadge.style.padding = '8px 10px';
      clipModeBadge.style.borderRadius = '999px';
      clipModeBadge.style.background = 'rgba(103, 196, 255, 0.14)';
      clipModeBadge.style.color = '#88d5ff';
      clipModeBadge.style.fontSize = '12px';
      clipModeBadge.style.fontWeight = '700';
      clipModeBadge.style.letterSpacing = '0.08em';
      clipModeBadge.style.textTransform = 'uppercase';

      const sizeBadge = document.createElement('div');
      sizeBadge.textContent = `${Math.round(image.naturalWidth)} x ${Math.round(image.naturalHeight)}`;
      sizeBadge.style.padding = '8px 10px';
      sizeBadge.style.borderRadius = '999px';
      sizeBadge.style.background = 'rgba(255,255,255,0.08)';
      sizeBadge.style.color = '#d5e2f4';
      sizeBadge.style.fontSize = '12px';
      sizeBadge.style.fontWeight = '600';

      metaRow.append(clipModeBadge, sizeBadge);

      const contentGrid = document.createElement('div');
      contentGrid.style.display = 'grid';
      contentGrid.style.gridTemplateColumns = 'minmax(0, 1fr) minmax(420px, 480px)';
      contentGrid.style.gap = '18px';
      contentGrid.style.minHeight = '0';
      contentGrid.style.height = '100%';

      const mainColumn = document.createElement('div');
      mainColumn.style.display = 'grid';
      mainColumn.style.gridTemplateRows = 'auto minmax(0, 1fr)';
      mainColumn.style.gap = '14px';
      mainColumn.style.minHeight = '0';

      const sideRail = document.createElement('aside');
      sideRail.dataset.snapclipScroll = 'hidden';
      sideRail.style.display = 'grid';
      sideRail.style.gridTemplateRows = 'minmax(0, 1fr)';
      sideRail.style.minHeight = '0';
      sideRail.style.overflow = 'hidden';
      sideRail.style.scrollbarWidth = 'none';
      sideRail.style.setProperty('-ms-overflow-style', 'none');

      const composePanel = document.createElement('div');
      composePanel.style.display = 'grid';
      composePanel.style.gridTemplateRows = 'minmax(0, 1fr) auto';
      composePanel.style.gap = '10px';
      composePanel.style.minHeight = '0';

      const debugWorkspace = document.createElement('section');
      debugWorkspace.dataset.snapclipScroll = 'hidden';
      debugWorkspace.style.display = 'none';
      debugWorkspace.style.gridTemplateRows = 'auto minmax(0, 1fr)';
      debugWorkspace.style.alignContent = 'start';
      debugWorkspace.style.gap = '12px';
      debugWorkspace.style.minHeight = '0';
      debugWorkspace.style.overflow = 'hidden';
      debugWorkspace.style.scrollbarWidth = 'none';
      debugWorkspace.style.setProperty('-ms-overflow-style', 'none');

      const detailsHead = document.createElement('div');
      detailsHead.style.display = 'flex';
      detailsHead.style.alignItems = 'flex-start';
      detailsHead.style.justifyContent = 'space-between';
      detailsHead.style.gap = '18px';
      detailsHead.style.padding = '2px 0 0';
      detailsHead.style.paddingRight = '72px';
      detailsHead.style.flexWrap = 'wrap';

      const detailsTitleBlock = document.createElement('div');
      detailsTitleBlock.style.display = 'grid';
      detailsTitleBlock.style.gap = '4px';

      const detailsHeaderStack = document.createElement('div');
      detailsHeaderStack.style.display = 'grid';
      detailsHeaderStack.style.gap = '12px';

      const detailsEyebrow = document.createElement('div');
      detailsEyebrow.textContent = 'DEBUG INFO';
      detailsEyebrow.style.color = '#88d5ff';
      detailsEyebrow.style.fontSize = '11px';
      detailsEyebrow.style.fontWeight = '700';
      detailsEyebrow.style.letterSpacing = '0.08em';
      detailsEyebrow.style.textTransform = 'uppercase';

      const detailsTitle = document.createElement('h3');
      detailsTitle.textContent = 'Debug inspector';
      detailsTitle.style.margin = '0';
      detailsTitle.style.fontSize = '22px';
      detailsTitle.style.color = '#eef4fb';

      const detailsLead = document.createElement('p');
      detailsLead.textContent =
        'What happened left. Why it failed right. Counts reflect events captured for this clip after the runtime monitor attached.';
      detailsLead.style.margin = '0';
      detailsLead.style.color = '#b7c4da';
      detailsLead.style.fontSize = '12px';
      detailsLead.style.lineHeight = '1.5';

      const detailsActions = document.createElement('div');
      detailsActions.style.display = 'flex';
      detailsActions.style.alignItems = 'center';
      detailsActions.style.gap = '8px';
      detailsActions.style.flexWrap = 'wrap';
      detailsActions.style.justifyContent = 'flex-end';
      detailsActions.style.maxWidth = 'calc(100% - 72px)';

      const copyDebugButton = document.createElement('button');
      copyDebugButton.textContent = 'Copy report';
      copyDebugButton.style.border = '0';
      copyDebugButton.style.borderRadius = '12px';
      copyDebugButton.style.padding = '10px 14px';
      copyDebugButton.style.font = 'inherit';
      copyDebugButton.style.fontWeight = '700';
      copyDebugButton.style.cursor = 'pointer';
      copyDebugButton.style.background = 'rgba(255,255,255,0.08)';
      copyDebugButton.style.color = '#edf3fb';

      const detailsBackButton = document.createElement('button');
      detailsBackButton.textContent = 'Back';
      detailsBackButton.style.border = '0';
      detailsBackButton.style.borderRadius = '12px';
      detailsBackButton.style.padding = '10px 14px';
      detailsBackButton.style.font = 'inherit';
      detailsBackButton.style.fontWeight = '700';
      detailsBackButton.style.cursor = 'pointer';
      detailsBackButton.style.background = 'rgba(255,255,255,0.08)';
      detailsBackButton.style.color = '#edf3fb';

      const claudeDebugStrip = document.createElement('div');
      claudeDebugStrip.style.display = 'grid';
      claudeDebugStrip.style.gap = '10px';
      claudeDebugStrip.style.padding = '12px 14px';
      claudeDebugStrip.style.borderRadius = '16px';
      claudeDebugStrip.style.background = 'rgba(255, 255, 255, 0.04)';
      claudeDebugStrip.style.border = '1px solid rgba(103, 209, 255, 0.16)';

      detailsTitleBlock.append(detailsEyebrow, detailsTitle, detailsLead);
      detailsHeaderStack.append(detailsTitleBlock);
      detailsActions.append(copyDebugButton, detailsBackButton);
      detailsHead.append(detailsHeaderStack, detailsActions);

      const stage = document.createElement('div');
      stage.style.position = 'relative';
      stage.style.borderRadius = '18px';
      stage.style.overflow = 'hidden';
      stage.style.border = '1px solid rgba(157, 177, 207, 0.16)';
      stage.style.background = '#050811';
      stage.style.cursor = 'none';
      stage.style.minHeight = '0';
      stage.style.touchAction = 'none';
      stage.style.userSelect = 'none';
      stage.style.outline = 'none';
      stage.tabIndex = 0;

      const stageImage = document.createElement('img');
      stageImage.src = clipDataUrl;
      stageImage.alt = clipTitle;
      stageImage.style.display = 'block';
      stageImage.style.width = '100%';
      stageImage.style.height = '100%';
      stageImage.style.maxHeight = '100%';
      stageImage.style.objectFit = 'contain';
      stageImage.style.userSelect = 'none';
      stageImage.draggable = false;

      stage.append(stageImage);

      const runtimeSummary = runtimeContext?.summary;
      const chromeDebugger = runtimeContext?.chromeDebugger ?? null;
      const debugCurrentUrl = chromeDebugger?.currentUrl || pageContext.url;
      const clipAreaLabel = `${Math.round(rect.width)} x ${Math.round(rect.height)} at ${Math.round(rect.x)}, ${Math.round(rect.y)}`;
      const viewportLabel = `${pageContext.viewport.width} x ${pageContext.viewport.height} @ ${pageContext.viewport.dpr}x`;
      const friendlyDebuggerMessage = (() => {
        const raw = chromeDebugger?.attachError;
        if (!raw) {
          return null;
        }

        const normalized = raw.toLowerCase();
        if (normalized.includes('requested protocol version is not supported')) {
          return 'Chrome did not allow the extra debugger snapshot for this page.';
        }
        if (normalized.includes('already attached')) {
          return 'Chrome already has this tab open in another debugger session.';
        }
        if (normalized.includes('permission')) {
          return 'Chrome blocked the extra debugger snapshot for this page.';
        }

        return raw;
      })();
      const summaryLines = [
        runtimeSummary ? `${runtimeSummary.eventCount} runtime events seen` : 'No runtime monitor data',
        runtimeSummary
          ? `${runtimeSummary.errorCount} runtime errors, ${runtimeSummary.warningCount} runtime warnings`
          : 'No errors or warnings captured',
        runtimeSummary
          ? `${runtimeSummary.failedRequestCount} failed requests, ${runtimeSummary.slowRequestCount} slow requests`
          : 'No network diagnostics captured',
        friendlyDebuggerMessage
          ? `Extra Chrome data unavailable: ${friendlyDebuggerMessage}`
          : chromeDebugger
            ? `${chromeDebugger.frameCount} frames • ${chromeDebugger.performance.nodes ?? 0} nodes • ${chromeDebugger.logs.length} Chrome logs`
            : 'No Chrome debugger snapshot attached',
      ];

      const recentMessages = [
        ...(runtimeContext?.events
          .filter((entry) => entry.level !== 'log')
          .slice(0, 3)
          .map((entry) => `${entry.level.toUpperCase()}: ${entry.message}`) ?? []),
        ...(runtimeContext?.network
          .filter((entry) => entry.classification !== 'ok')
          .slice(0, 2)
          .map((entry) => `${entry.method} ${entry.status ?? 'ERR'} ${entry.url}`) ?? []),
      ].slice(0, 4);

      const buildDebugReportText = () =>
        [
          `# Debug report for ${clipTitle}`,
          '',
          noteField.value.trim() ? `Instructions:\n${noteField.value.trim()}` : '',
          '',
          `Page: ${pageContext.title || 'Untitled page'}`,
          `URL: ${pageContext.url}`,
          `Viewport: ${viewportLabel}`,
          `Clip area: ${clipAreaLabel}`,
          `Platform: ${pageContext.platform}`,
          `Language: ${pageContext.language}`,
          `Time zone: ${pageContext.timeZone}`,
          `User agent: ${pageContext.userAgent}`,
          '',
          'Runtime summary:',
          ...(runtimeSummary
            ? [
                `- ${runtimeSummary.eventCount} events`,
                `- ${runtimeSummary.errorCount} errors`,
                `- ${runtimeSummary.warningCount} warnings`,
                `- ${runtimeSummary.failedRequestCount} failed requests`,
                `- ${runtimeSummary.slowRequestCount} slow requests`,
                `- monitor installed ${new Date(runtimeSummary.installedAt).toLocaleTimeString()}`,
                `- last seen ${new Date(runtimeSummary.lastSeenAt).toLocaleTimeString()}`,
              ]
            : ['- No runtime monitor data']),
          '',
          pageContext.domSummary.selectedText ? `Selected text: ${pageContext.domSummary.selectedText}` : 'Selected text: none',
          '',
          'Console and runtime events:',
          ...(runtimeContext?.events.length
            ? runtimeContext.events.map((entry) => {
                const sourceBits = [entry.source, entry.url, entry.title].filter(Boolean).join(' • ');
                return `- [${entry.level.toUpperCase()}] ${entry.type}: ${entry.message}${sourceBits ? ` (${sourceBits})` : ''}`;
              })
            : ['- No runtime events captured']),
          '',
          'Network requests:',
          ...(runtimeContext?.network.length
            ? runtimeContext.network.map((entry) => {
                const status = entry.status === null ? 'ERR' : String(entry.status);
                const suffix = entry.error ? ` • ${entry.error}` : '';
                return `- ${entry.method} ${status} ${entry.durationMs}ms ${entry.url} • ${entry.classification}${suffix}`;
              })
            : ['- No network requests captured']),
          '',
          'DOM summary:',
          `- Path: ${runtimeContext?.domSummary?.path || `${window.location.pathname}${window.location.search}${window.location.hash}`}`,
          `- Headings: ${(runtimeContext?.domSummary?.headingTexts || []).join(', ') || 'None captured'}`,
          `- Buttons: ${(runtimeContext?.domSummary?.buttonTexts || []).join(', ') || 'None captured'}`,
          `- Fields: ${(runtimeContext?.domSummary?.inputLabels || []).join(', ') || 'None captured'}`,
          '',
          'Chrome debugger snapshot:',
          ...(chromeDebugger
            ? [
                chromeDebugger.attachError ? `- Attach error: ${chromeDebugger.attachError}` : '- Attach error: none',
                chromeDebugger.detachReason ? `- Detach reason: ${chromeDebugger.detachReason}` : '- Detach reason: none',
                `- Captured at: ${chromeDebugger.capturedAt}`,
                `- Current URL: ${chromeDebugger.currentUrl}`,
                `- Current title: ${chromeDebugger.currentTitle}`,
                `- Frame count: ${chromeDebugger.frameCount}`,
                `- Layout viewport: ${chromeDebugger.layout.viewportWidth ?? 'n/a'} x ${chromeDebugger.layout.viewportHeight ?? 'n/a'}`,
                `- Content size: ${chromeDebugger.layout.contentWidth ?? 'n/a'} x ${chromeDebugger.layout.contentHeight ?? 'n/a'}`,
                `- DOM nodes: ${chromeDebugger.performance.nodes ?? 'n/a'}`,
                `- JS listeners: ${chromeDebugger.performance.jsEventListeners ?? 'n/a'}`,
                `- JS heap used: ${chromeDebugger.performance.jsHeapUsedSize ?? 'n/a'}`,
                `- JS heap total: ${chromeDebugger.performance.jsHeapTotalSize ?? 'n/a'}`,
                '',
                'Chrome debugger logs:',
                ...(chromeDebugger.logs.length
                  ? chromeDebugger.logs.map((entry) => {
                      const bits = [entry.source, entry.level, entry.url].filter(Boolean).join(' • ');
                      return `- ${bits}: ${entry.text}`;
                    })
                  : ['- No Chrome debugger logs captured']),
                '',
                'Chrome debugger network:',
                ...(chromeDebugger.network.length
                  ? chromeDebugger.network.map((entry) => {
                      const status = entry.status === null || typeof entry.status === 'undefined' ? 'ERR' : String(entry.status);
                      const extra = [
                        entry.resourceType,
                        entry.mimeType,
                        entry.failedReason,
                        entry.blockedReason,
                        entry.hasRequestHeaders ? `${entry.requestHeaders?.length ?? 0} req headers` : '',
                        entry.hasResponseHeaders ? `${entry.responseHeaders?.length ?? 0} res headers` : '',
                      ]
                        .filter(Boolean)
                        .join(' • ');
                      return `- ${entry.method} ${status} ${entry.url}${extra ? ` • ${extra}` : ''}`;
                    })
                  : ['- No Chrome debugger network entries captured']),
              ]
            : ['- No Chrome debugger snapshot attached']),
        ]
          .filter(Boolean)
          .join('\n');

      const makeSectionCard = (title: string, subtitle?: string) => {
        const card = document.createElement('section');
        card.style.display = 'grid';
        card.style.gap = '8px';
        card.style.padding = '12px';
        card.style.borderRadius = '14px';
        card.style.border = '1px solid rgba(157, 177, 207, 0.12)';
        card.style.background = 'rgba(255, 255, 255, 0.028)';

        const head = document.createElement('div');
        head.style.display = 'grid';
        head.style.gap = '4px';

        const heading = document.createElement('h4');
        heading.textContent = title;
        heading.style.margin = '0';
        heading.style.fontSize = '14px';
        heading.style.color = '#eef4fb';

        head.append(heading);

        if (subtitle) {
          const sub = document.createElement('p');
          sub.textContent = subtitle;
          sub.style.margin = '0';
          sub.style.color = '#9db2cf';
          sub.style.fontSize = '11px';
          sub.style.lineHeight = '1.45';
          head.append(sub);
        }

        card.append(head);
        return card;
      };

      const makeMetricPill = (label: string, value: string, tone: 'default' | 'error' | 'warn' = 'default') => {
        const pill = document.createElement('div');
        pill.style.display = 'grid';
        pill.style.gap = '1px';
        pill.style.padding = '10px 12px';
        pill.style.borderRadius = '12px';
        pill.style.border =
          tone === 'error'
            ? '1px solid rgba(255, 132, 95, 0.2)'
            : tone === 'warn'
              ? '1px solid rgba(255, 196, 94, 0.22)'
              : '1px solid rgba(157, 177, 207, 0.14)';
        pill.style.background =
          tone === 'error'
            ? 'rgba(105, 31, 40, 0.2)'
            : tone === 'warn'
              ? 'rgba(82, 61, 17, 0.2)'
              : 'rgba(255, 255, 255, 0.035)';

        const metricValue = document.createElement('strong');
        metricValue.textContent = value;
        metricValue.style.color = '#eef4fb';
        metricValue.style.fontSize = '15px';

        const metricLabel = document.createElement('span');
        metricLabel.textContent = label;
        metricLabel.style.color = '#9db2cf';
        metricLabel.style.fontSize = '11px';
        metricLabel.style.fontWeight = '700';
        metricLabel.style.letterSpacing = '0.08em';
        metricLabel.style.textTransform = 'uppercase';

        pill.append(metricValue, metricLabel);
        return pill;
      };

      const makeKeyValueRow = (label: string, value: string) => {
        const row = document.createElement('div');
        row.style.display = 'grid';
        row.style.gap = '4px';

        const dt = document.createElement('div');
        dt.textContent = label;
        dt.style.color = '#88a2c6';
        dt.style.fontSize = '11px';
        dt.style.fontWeight = '700';
        dt.style.letterSpacing = '0.08em';
        dt.style.textTransform = 'uppercase';

        const dd = document.createElement('div');
        dd.textContent = value;
        dd.style.color = '#d8e3f2';
        dd.style.fontSize = '13px';
        dd.style.lineHeight = '1.45';
        dd.style.wordBreak = 'break-word';

        row.append(dt, dd);
        return row;
      };

      const makeEmptyInspectorMessage = (message: string) => {
        const empty = document.createElement('div');
        empty.textContent = message;
        empty.style.padding = '14px';
        empty.style.borderRadius = '16px';
        empty.style.border = '1px solid rgba(157, 177, 207, 0.14)';
        empty.style.background = 'rgba(255, 255, 255, 0.03)';
        empty.style.color = '#9db2cf';
        empty.style.fontSize = '13px';
        empty.style.lineHeight = '1.5';
        return empty;
      };

      type InsightTone = 'default' | 'error' | 'warn';
      type InsightRow = { label: string; value: string; tone?: InsightTone };
      type DebugInspectorTab = 'info' | 'console' | 'network' | 'actions' | 'ai';

      const overviewStrip = document.createElement('div');
      overviewStrip.style.display = 'grid';
      overviewStrip.style.gridTemplateColumns = 'repeat(4, minmax(0, 1fr))';
      overviewStrip.style.gap = '8px';
      overviewStrip.style.paddingBottom = '4px';

      overviewStrip.append(
        makeMetricPill('Errors', String(runtimeSummary?.errorCount ?? 0), 'error'),
        makeMetricPill('Warnings', String(runtimeSummary?.warningCount ?? 0), 'warn'),
        makeMetricPill('Failed', String(runtimeSummary?.failedRequestCount ?? 0), 'error'),
        makeMetricPill('Slow', String(runtimeSummary?.slowRequestCount ?? 0), 'warn'),
      );

      const makeInsightList = (items: InsightRow[], emptyText: string) => {
        const list = document.createElement('div');
        list.style.display = 'grid';
        list.style.gap = '8px';

        if (!items.length) {
          list.append(makeEmptyInspectorMessage(emptyText));
          return list;
        }

        items.forEach((entry) => {
          const item = document.createElement('div');
          item.style.display = 'grid';
          item.style.gap = '4px';
          item.style.padding = '10px 12px';
          item.style.borderRadius = '12px';
          item.style.border =
            entry.tone === 'error'
              ? '1px solid rgba(255, 132, 95, 0.24)'
              : entry.tone === 'warn'
                ? '1px solid rgba(255, 196, 94, 0.24)'
                : '1px solid rgba(157, 177, 207, 0.14)';
          item.style.background =
            entry.tone === 'error'
              ? 'rgba(105, 31, 40, 0.18)'
              : entry.tone === 'warn'
                ? 'rgba(82, 61, 17, 0.18)'
                : 'rgba(255, 255, 255, 0.035)';

          const label = document.createElement('div');
          label.textContent = entry.label;
          label.style.color = '#9db2cf';
          label.style.fontSize = '11px';
          label.style.fontWeight = '700';
          label.style.letterSpacing = '0.08em';
          label.style.textTransform = 'uppercase';

          const value = document.createElement('div');
          value.textContent = entry.value;
          value.style.color = '#eef4fb';
          value.style.fontSize = '12px';
          value.style.lineHeight = '1.5';
          value.style.wordBreak = 'break-word';

          item.append(label, value);
          list.append(item);
        });

        return list;
      };

      const requestHighlights: InsightRow[] = [
        ...(runtimeContext?.network
          .filter((entry) => entry.classification !== 'ok')
          .slice(0, 5)
          .map((entry) => ({
            label: `${entry.method} ${entry.status ?? 'ERR'} • ${entry.durationMs}ms`,
            value: entry.url,
            tone: entry.classification === 'failed' ? ('error' as const) : ('warn' as const),
          })) ?? []),
        ...(chromeDebugger?.network
          .filter(
            (entry) =>
              entry.failedReason ||
              entry.blockedReason ||
              entry.status === null ||
              (typeof entry.status === 'number' && entry.status >= 400),
          )
          .slice(0, 3)
          .map((entry) => ({
            label: `Chrome ${entry.method} ${typeof entry.status === 'number' ? entry.status : 'ERR'}`,
            value: entry.url,
            tone: 'error' as const,
          })) ?? []),
      ].slice(0, 6);

      const debugPreviewCard = makeSectionCard(
        pageContext.title || 'Captured clip',
        'Synthetic browser frame using the saved page URL.',
      );
      debugPreviewCard.style.padding = '12px';
      debugPreviewCard.style.gap = '12px';

      const previewBrowserFrame = document.createElement('div');
      previewBrowserFrame.style.display = 'grid';
      previewBrowserFrame.style.gap = '0';
      previewBrowserFrame.style.borderRadius = '20px';
      previewBrowserFrame.style.overflow = 'hidden';
      previewBrowserFrame.style.border = '1px solid rgba(157, 177, 207, 0.14)';
      previewBrowserFrame.style.background = 'rgba(8, 12, 22, 0.96)';

      const previewBrowserChrome = document.createElement('div');
      previewBrowserChrome.style.display = 'grid';
      previewBrowserChrome.style.gridTemplateColumns = 'auto minmax(0, 1fr) auto';
      previewBrowserChrome.style.alignItems = 'center';
      previewBrowserChrome.style.gap = '12px';
      previewBrowserChrome.style.padding = '12px 14px';
      previewBrowserChrome.style.background =
        'linear-gradient(180deg, rgba(74, 52, 98, 0.94) 0%, rgba(54, 38, 74, 0.96) 100%)';
      previewBrowserChrome.style.borderBottom = '1px solid rgba(154, 177, 205, 0.12)';

      const previewBrowserDots = document.createElement('div');
      previewBrowserDots.style.display = 'flex';
      previewBrowserDots.style.alignItems = 'center';
      previewBrowserDots.style.gap = '8px';

      ['rgba(250, 95, 87, 0.9)', 'rgba(251, 188, 5, 0.92)', 'rgba(52, 199, 89, 0.92)'].forEach((color) => {
        const dot = document.createElement('span');
        dot.style.display = 'block';
        dot.style.width = '10px';
        dot.style.height = '10px';
        dot.style.borderRadius = '999px';
        dot.style.background = color;
        previewBrowserDots.append(dot);
      });

      const previewUrlBar = document.createElement('div');
      previewUrlBar.textContent = debugCurrentUrl;
      previewUrlBar.style.minWidth = '0';
      previewUrlBar.style.padding = '11px 16px';
      previewUrlBar.style.borderRadius = '999px';
      previewUrlBar.style.background = 'rgba(255,255,255,0.08)';
      previewUrlBar.style.color = '#efe8ff';
      previewUrlBar.style.fontSize = '13px';
      previewUrlBar.style.lineHeight = '1.35';
      previewUrlBar.style.whiteSpace = 'nowrap';
      previewUrlBar.style.overflow = 'hidden';
      previewUrlBar.style.textOverflow = 'ellipsis';

      const previewBrowserTag = document.createElement('span');
      previewBrowserTag.textContent = 'Saved URL';
      previewBrowserTag.style.display = 'inline-flex';
      previewBrowserTag.style.alignItems = 'center';
      previewBrowserTag.style.padding = '0 10px';
      previewBrowserTag.style.minHeight = '30px';
      previewBrowserTag.style.borderRadius = '999px';
      previewBrowserTag.style.background = 'rgba(255,255,255,0.08)';
      previewBrowserTag.style.color = '#d7def0';
      previewBrowserTag.style.fontSize = '11px';
      previewBrowserTag.style.fontWeight = '700';
      previewBrowserTag.style.letterSpacing = '0.08em';
      previewBrowserTag.style.textTransform = 'uppercase';

      previewBrowserChrome.append(previewBrowserDots, previewUrlBar, previewBrowserTag);

      const previewCanvas = document.createElement('div');
      previewCanvas.style.padding = '20px';
      previewCanvas.style.background =
        'linear-gradient(180deg, rgba(222, 223, 230, 0.94) 0%, rgba(208, 208, 214, 0.98) 100%)';

      const debugPreviewImage = document.createElement('img');
      debugPreviewImage.src = clipDataUrl;
      debugPreviewImage.alt = clipTitle;
      debugPreviewImage.style.display = 'block';
      debugPreviewImage.style.width = '100%';
      debugPreviewImage.style.maxHeight = '520px';
      debugPreviewImage.style.objectFit = 'contain';
      debugPreviewImage.style.borderRadius = '18px';
      debugPreviewImage.style.background = '#ffffff';
      debugPreviewImage.style.boxShadow = '0 24px 60px rgba(4, 10, 20, 0.26)';

      previewCanvas.append(debugPreviewImage);
      previewBrowserFrame.append(previewBrowserChrome, previewCanvas);

      const previewMeta = document.createElement('div');
      previewMeta.style.display = 'grid';
      previewMeta.style.gap = '8px';
      previewMeta.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
      previewMeta.append(
        makeKeyValueRow('Page', pageContext.title || 'Untitled page'),
        makeKeyValueRow('Viewport', viewportLabel),
        makeKeyValueRow('URL', debugCurrentUrl),
        makeKeyValueRow('Captured', clipMode === 'visible' ? 'Visible tab clip' : 'Area clip'),
        makeKeyValueRow('Clip area', clipAreaLabel),
        makeKeyValueRow('Snapshot', chromeDebugger?.attachError ? 'Runtime only' : 'Runtime + debugger'),
      );
      debugPreviewCard.append(previewBrowserFrame, previewMeta);

      const promptSummaryCard = makeSectionCard('Agent prompt', 'This prompt stays attached to the clip.');
      const promptSummaryBody = document.createElement('div');
      promptSummaryBody.textContent =
        noteField.value.trim() || 'No prompt yet. Add one when you go back to the editor.';
      promptSummaryBody.style.padding = '14px';
      promptSummaryBody.style.borderRadius = '16px';
      promptSummaryBody.style.border = '1px solid rgba(103, 209, 255, 0.18)';
      promptSummaryBody.style.background = 'rgba(255, 255, 255, 0.035)';
      promptSummaryBody.style.color = noteField.value.trim() ? '#eef4fb' : '#9db2cf';
      promptSummaryBody.style.fontSize = '14px';
      promptSummaryBody.style.lineHeight = '1.6';
      promptSummaryBody.style.whiteSpace = 'pre-wrap';

      promptSummaryCard.append(promptSummaryBody);

      const infoSummaryCard = makeSectionCard('Environment', 'Saved with the packet.');
      const infoMetaGrid = document.createElement('div');
      infoMetaGrid.style.display = 'grid';
      infoMetaGrid.style.gap = '10px';
      infoMetaGrid.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
      infoMetaGrid.append(
        makeKeyValueRow('URL', debugCurrentUrl),
        makeKeyValueRow('Captured at', new Date(chromeDebugger?.capturedAt || new Date().toISOString()).toLocaleString()),
        makeKeyValueRow('Browser', pageContext.userAgent),
        makeKeyValueRow('Viewport', viewportLabel),
        makeKeyValueRow('Page title', pageContext.title || 'Untitled page'),
        makeKeyValueRow('Debugger status', chromeDebugger?.attachError || 'Snapshot captured'),
      );
      infoSummaryCard.append(infoMetaGrid);

      const makeStreamRows = (
        items: Array<{
          eyebrow: string;
          title: string;
          detail?: string | null;
          tone?: InsightTone;
        }>,
        emptyText: string,
      ) => {
        const list = document.createElement('div');
        list.style.display = 'grid';
        list.style.gap = '10px';

        if (!items.length) {
          list.append(makeEmptyInspectorMessage(emptyText));
          return list;
        }

        items.forEach((entry) => {
          const row = document.createElement('div');
          row.style.display = 'grid';
          row.style.gap = '4px';
          row.style.padding = '10px 12px';
          row.style.borderRadius = '12px';
          row.style.border =
            entry.tone === 'error'
              ? '1px solid rgba(255, 132, 95, 0.24)'
              : entry.tone === 'warn'
                ? '1px solid rgba(255, 196, 94, 0.22)'
                : '1px solid rgba(157, 177, 207, 0.14)';
          row.style.background =
            entry.tone === 'error'
              ? 'rgba(105, 31, 40, 0.2)'
              : entry.tone === 'warn'
                ? 'rgba(82, 61, 17, 0.2)'
                : 'rgba(255, 255, 255, 0.035)';

          const eyebrow = document.createElement('div');
          eyebrow.textContent = entry.eyebrow;
          eyebrow.style.color = '#88a2c6';
          eyebrow.style.fontSize = '11px';
          eyebrow.style.fontWeight = '700';
          eyebrow.style.letterSpacing = '0.08em';
          eyebrow.style.textTransform = 'uppercase';

          const title = document.createElement('div');
          title.textContent = entry.title;
          title.style.color = '#eef4fb';
          title.style.fontSize = '12px';
          title.style.lineHeight = '1.5';
          title.style.wordBreak = 'break-word';

          row.append(eyebrow, title);

          if (entry.detail) {
            const detail = document.createElement('div');
            detail.textContent = entry.detail;
            detail.style.color = '#9db2cf';
            detail.style.fontSize = '11px';
            detail.style.lineHeight = '1.5';
            detail.style.wordBreak = 'break-word';
            row.append(detail);
          }

          list.append(row);
        });

        return list;
      };

      const consoleDetailItems =
        runtimeContext?.events.map((entry) => ({
          eyebrow: `${entry.level.toUpperCase()} • ${entry.type.replaceAll('_', ' ')}`,
          title: entry.message,
          detail: [entry.source, entry.url, entry.title, entry.timestamp].filter(Boolean).join(' • '),
          tone: entry.level === 'error' ? ('error' as const) : entry.level === 'warn' ? ('warn' as const) : ('default' as const),
        })) ?? [];

      const consoleDetailCard = makeSectionCard('Runtime');
      consoleDetailCard.append(
        makeStreamRows(consoleDetailItems, 'No runtime events were captured for this clip.'),
      );

      const chromeLogItems =
        chromeDebugger?.logs.map((entry) => ({
          eyebrow: [entry.source, entry.level].filter(Boolean).join(' • ').toUpperCase(),
          title: entry.text,
          detail: [entry.url, entry.timestamp].filter(Boolean).join(' • '),
          tone: entry.level === 'error' ? ('error' as const) : entry.level === 'warning' ? ('warn' as const) : ('default' as const),
        })) ?? [];

      const chromeLogCard = makeSectionCard('Browser');
      chromeLogCard.append(
        makeStreamRows(
          chromeLogItems,
          friendlyDebuggerMessage
            ? `Chrome logs are unavailable for this clip: ${friendlyDebuggerMessage}`
            : 'No Chrome debugger logs were attached to this clip.',
        ),
      );

      const runtimeNetworkItems =
        runtimeContext?.network.map((entry) => ({
          eyebrow: `${entry.method} ${entry.status ?? 'ERR'} • ${entry.durationMs}ms`,
          title: entry.url,
          detail: [entry.transport.toUpperCase(), entry.classification, entry.error].filter(Boolean).join(' • '),
          tone: entry.classification === 'failed' ? ('error' as const) : entry.classification === 'slow' ? ('warn' as const) : ('default' as const),
        })) ?? [];

      const runtimeNetworkCard = makeSectionCard('Page requests');
      runtimeNetworkCard.append(
        makeStreamRows(runtimeNetworkItems, 'No runtime network requests were captured for this clip.'),
      );

      const chromeNetworkItems =
        chromeDebugger?.network.map((entry) => {
          const reqHeaderCount = entry.requestHeaders?.length ?? 0;
          const resHeaderCount = entry.responseHeaders?.length ?? 0;
          return {
            eyebrow: `${entry.method} ${typeof entry.status === 'number' ? entry.status : 'ERR'}${entry.resourceType ? ` • ${entry.resourceType}` : ''}`,
            title: entry.url,
            detail: [
              entry.mimeType,
              entry.failedReason,
              entry.blockedReason,
              entry.hasRequestHeaders ? `${reqHeaderCount} request headers` : '',
              entry.hasResponseHeaders ? `${resHeaderCount} response headers` : '',
              entry.timestamp,
            ]
              .filter(Boolean)
              .join(' • '),
            tone:
              entry.failedReason || entry.blockedReason || entry.status === null || (typeof entry.status === 'number' && entry.status >= 400)
                ? ('error' as const)
                : ('default' as const),
          };
        }) ?? [];

      const chromeNetworkCard = makeSectionCard('Browser requests');
      chromeNetworkCard.append(
        makeStreamRows(
          chromeNetworkItems,
          friendlyDebuggerMessage
            ? `Chrome network details are unavailable for this clip: ${friendlyDebuggerMessage}`
            : 'No Chrome debugger requests were attached to this clip.',
        ),
      );

      const networkFocusCard = makeSectionCard('What stands out');
      networkFocusCard.append(
        makeInsightList(
          requestHighlights,
          'No failing or slow requests were captured for this clip.',
        ),
      );

      const formatTimelineOffset = (timestamp: string, baseline: number) => {
        const current = Date.parse(timestamp);
        if (Number.isNaN(current)) {
          return '--:--';
        }
        const deltaSeconds = Math.max(0, Math.round((current - baseline) / 1000));
        const minutes = Math.floor(deltaSeconds / 60)
          .toString()
          .padStart(2, '0');
        const seconds = (deltaSeconds % 60).toString().padStart(2, '0');
        return `${minutes}:${seconds}`;
      };

      const actionTimelineItems = [
        ...(runtimeContext?.events.map((entry) => ({
          timestamp: entry.timestamp,
          eyebrow: entry.type === 'route_change' ? 'Navigation' : `${entry.level.toUpperCase()} signal`,
          title:
            entry.type === 'route_change'
              ? entry.message
              : `${entry.message}`,
          detail: [entry.url, entry.source].filter(Boolean).join(' • '),
          tone: entry.level === 'error' ? ('error' as const) : entry.level === 'warn' ? ('warn' as const) : ('default' as const),
        })) ?? []),
        ...(runtimeContext?.network
          .filter((entry) => entry.classification !== 'ok')
          .map((entry) => ({
            timestamp: entry.finishedAt,
            eyebrow: entry.classification === 'failed' ? 'Request failed' : 'Request slow',
            title: `${entry.method} ${entry.status ?? 'ERR'} ${entry.url}`,
            detail: `${entry.durationMs}ms${entry.error ? ` • ${entry.error}` : ''}`,
            tone: entry.classification === 'failed' ? ('error' as const) : ('warn' as const),
          })) ?? []),
      ]
        .filter((entry) => entry.timestamp)
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

      const actionTimelineBase =
        actionTimelineItems.length && !Number.isNaN(Date.parse(actionTimelineItems[0].timestamp))
          ? Date.parse(actionTimelineItems[0].timestamp)
          : Date.now();

      const actionTimelineCard = makeSectionCard('Timeline');
      actionTimelineCard.append(
        makeStreamRows(
          actionTimelineItems.map((entry) => ({
            eyebrow: `${formatTimelineOffset(entry.timestamp, actionTimelineBase)} • ${entry.eyebrow}`,
            title: entry.title,
            detail: entry.detail,
            tone: entry.tone,
          })),
          'No route changes, warnings, errors, or suspicious requests were captured for this clip.',
        ),
      );

      const debugTabs = document.createElement('div');
      debugTabs.style.display = 'flex';
      debugTabs.style.alignItems = 'center';
      debugTabs.style.gap = '2px';
      debugTabs.style.flexWrap = 'nowrap';
      debugTabs.style.overflowX = 'auto';
      debugTabs.style.paddingBottom = '6px';
      debugTabs.style.borderBottom = '1px solid rgba(157, 177, 207, 0.12)';
      debugTabs.setAttribute('role', 'tablist');
      debugTabs.setAttribute('aria-label', 'Debug inspector tabs');

      const debugPanel = document.createElement('div');
      debugPanel.style.display = 'grid';
      debugPanel.style.alignContent = 'start';
      debugPanel.style.gap = '14px';
      debugPanel.style.minHeight = '0';
      debugPanel.style.overflowY = 'auto';
      debugPanel.style.paddingRight = '4px';

      const debugRail = document.createElement('section');
      debugRail.style.display = 'grid';
      debugRail.style.gridTemplateRows = 'auto auto minmax(0, 1fr)';
      debugRail.style.gap = '12px';
      debugRail.style.minHeight = '0';

      const debugShell = document.createElement('div');
      debugShell.style.display = 'grid';
      debugShell.style.gridTemplateColumns = 'minmax(0, 1.12fr) minmax(560px, 680px)';
      debugShell.style.gap = '18px';
      debugShell.style.minHeight = '0';

      const debugTabButtons = new Map<DebugInspectorTab, HTMLButtonElement>();
      const debugTabConfig: Array<{ key: DebugInspectorTab; label: string }> = [
        { key: 'info', label: 'Info' },
        { key: 'console', label: 'Console' },
        { key: 'network', label: 'Network' },
        { key: 'actions', label: 'Actions' },
        { key: 'ai', label: 'AI' },
      ];
      let activeDebugTab: DebugInspectorTab = 'network';

      const getDebugTabNodes = (tab: DebugInspectorTab) => {
        switch (tab) {
          case 'info':
            return [infoSummaryCard];
          case 'console':
            return [consoleDetailCard, chromeLogCard];
          case 'network':
            return [networkFocusCard, chromeNetworkCard, runtimeNetworkCard];
          case 'actions':
            return [actionTimelineCard];
          case 'ai':
            return [promptSummaryCard];
        }
      };

      const renderDebugTab = () => {
        debugTabButtons.forEach((button, key) => {
          const active = key === activeDebugTab;
          button.setAttribute('aria-selected', active ? 'true' : 'false');
          button.tabIndex = active ? 0 : -1;
          button.style.background = 'transparent';
          button.style.borderColor = 'transparent';
          button.style.color = active ? '#eef7ff' : '#8ea6c5';
          button.style.boxShadow = active ? 'inset 0 -2px 0 rgba(103, 209, 255, 0.72)' : 'none';
          button.style.opacity = active ? '1' : '0.88';
        });

        debugPanel.replaceChildren(...getDebugTabNodes(activeDebugTab));
      };

      const activateDebugTab = (tab: DebugInspectorTab) => {
        activeDebugTab = tab;
        renderDebugTab();
      };

      debugTabConfig.forEach(({ key, label }, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', 'snapclip-debug-panel');
        button.style.border = '1px solid transparent';
        button.style.borderRadius = '0';
        button.style.padding = '12px 16px 10px';
        button.style.minHeight = '40px';
        button.style.background = 'transparent';
        button.style.color = '#8ea6c5';
        button.style.font = 'inherit';
        button.style.fontSize = '14px';
        button.style.fontWeight = '700';
        button.style.cursor = 'pointer';
        button.style.flex = '0 0 auto';
        button.addEventListener('click', () => activateDebugTab(key));
        button.addEventListener('keydown', (event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
            return;
          }
          event.preventDefault();
          const nextIndex =
            event.key === 'ArrowRight'
              ? (index + 1) % debugTabConfig.length
              : (index - 1 + debugTabConfig.length) % debugTabConfig.length;
          const nextTab = debugTabConfig[nextIndex];
          activateDebugTab(nextTab.key);
          debugTabButtons.get(nextTab.key)?.focus();
        });
        debugTabButtons.set(key, button);
        debugTabs.append(button);
      });

      debugPanel.id = 'snapclip-debug-panel';
      debugPanel.setAttribute('role', 'tabpanel');
      debugPanel.setAttribute('aria-label', 'Debug inspector content');
      debugWorkspace.style.gridColumn = '1 / -1';
      debugRail.append(overviewStrip, debugTabs, debugPanel);
      debugShell.append(debugPreviewCard, debugRail);
      debugWorkspace.append(detailsHead, debugShell);
      renderDebugTab();

      const scrollbarStyle = document.createElement('style');
      scrollbarStyle.textContent = `
        [data-snapclip-scroll="hidden"]::-webkit-scrollbar {
          width: 0;
          height: 0;
          display: none;
        }
      `;

      mainColumn.append(metaRow, stage);
      composePanel.append(noteCard, actionRow);
      sideRail.append(composePanel);
      contentGrid.append(mainColumn, sideRail, debugWorkspace);
      editor.append(scrollbarStyle, closeButton, contentGrid);
      root.append(editor, cursorBubble);

      const syncDebugWorkspace = () => {
        const promptText = noteField.value.trim();
        promptSummaryBody.textContent = promptText || 'No prompt yet. Add one when you go back to the editor.';
        promptSummaryBody.style.color = promptText ? '#eef4fb' : '#9db2cf';
        if (activeDebugTab === 'ai') {
          renderDebugTab();
        }
      };

      noteField.addEventListener('input', syncDebugWorkspace);
      syncDebugWorkspace();

      window.setTimeout(() => {
        noteField.focus();
      }, 30);

      let activeTool: 'text' | 'box' | 'arrow' = 'box';
      let railMode: 'compose' | 'details' = 'compose';
      let editorStartPoint: { x: number; y: number } | null = null;
      let editorDraftShape:
        | { kind: 'box'; x: number; y: number; width: number; height: number }
        | { kind: 'arrow'; startX: number; startY: number; endX: number; endY: number }
        | null = null;
      let annotations: ClipAnnotation[] = (initialClip?.annotations ?? []).map((annotation) => ({ ...annotation }));
      let selectedAnnotationId: string | null = null;

      const annotationColor = '#ff8a5b';
      let pendingTextPoint: { x: number; y: number } | null = null;
      let editingTextAnnotationId: string | null = null;
      const textBounds = new Map<string, { left: number; right: number; top: number; bottom: number }>();
      let movingAnnotation:
        | {
            id: string;
            mode: 'move' | 'resize-box' | 'resize-arrow-start' | 'resize-arrow-end';
            startPoint: { x: number; y: number };
            original: ClipAnnotation;
          }
        | null = null;
      let composerDragOffset: { x: number; y: number } | null = null;
      let isStageHovered = false;
      let lastStagePointer: { clientX: number; clientY: number } | null = null;

      const describeStageCursor = () => {
        if (movingAnnotation) {
          if (movingAnnotation.mode === 'resize-box') {
            return 'Drag to resize box';
          }
          if (movingAnnotation.mode === 'resize-arrow-start' || movingAnnotation.mode === 'resize-arrow-end') {
            return 'Drag to retarget arrow';
          }
          return movingAnnotation.original.kind === 'text'
            ? 'Move text'
            : movingAnnotation.original.kind === 'box'
              ? 'Move box'
              : 'Move arrow';
        }

        if (editorDraftShape) {
          if (editorDraftShape.kind === 'box') {
            const bounds = stage.getBoundingClientRect();
            const width = Math.round((editorDraftShape.width / 100) * bounds.width);
            const height = Math.round((editorDraftShape.height / 100) * bounds.height);
            return width > 0 && height > 0 ? `${width} x ${height}` : 'Drag to draw box';
          }

          return 'Release to place arrow';
        }

        if (selectedAnnotationId) {
          const selectedAnnotation = annotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null;
          if (selectedAnnotation?.kind === 'text') {
            return 'Drag to move text';
          }
          if (selectedAnnotation?.kind === 'box') {
            return 'Drag to move box';
          }
          if (selectedAnnotation?.kind === 'arrow') {
            return 'Drag to move arrow';
          }
        }

        return activeTool === 'text'
          ? 'Click to add text'
          : activeTool === 'box'
            ? 'Drag to draw box'
            : 'Drag to draw arrow';
      };

      const textComposer = document.createElement('div');
      textComposer.style.position = 'absolute';
      textComposer.style.display = 'none';
      textComposer.style.zIndex = '2';
      textComposer.style.width = 'min(280px, calc(100% - 24px))';
      textComposer.style.padding = '12px';
      textComposer.style.borderRadius = '14px';
      textComposer.style.background = 'rgba(8, 15, 28, 0.96)';
      textComposer.style.border = `1px solid ${annotationColor}`;
      textComposer.style.boxShadow = '0 18px 48px rgba(0, 0, 0, 0.35)';
      textComposer.style.display = 'none';
      textComposer.style.gap = '10px';
      textComposer.style.cursor = 'default';

      const textComposerHeader = document.createElement('div');
      textComposerHeader.style.display = 'flex';
      textComposerHeader.style.alignItems = 'center';
      textComposerHeader.style.justifyContent = 'space-between';
      textComposerHeader.style.gap = '10px';
      textComposerHeader.style.cursor = 'grab';

      const textComposerLabel = document.createElement('div');
      textComposerLabel.textContent = 'Text annotation';
      textComposerLabel.style.fontSize = '12px';
      textComposerLabel.style.fontWeight = '700';
      textComposerLabel.style.letterSpacing = '0.08em';
      textComposerLabel.style.textTransform = 'uppercase';
      textComposerLabel.style.color = '#88d5ff';

      const textComposerClose = document.createElement('button');
      textComposerClose.textContent = 'X';
      textComposerClose.setAttribute('aria-label', 'Close text annotation composer');
      textComposerClose.style.width = '28px';
      textComposerClose.style.minWidth = '28px';
      textComposerClose.style.height = '28px';
      textComposerClose.style.borderRadius = '999px';
      textComposerClose.style.border = '0';
      textComposerClose.style.background = 'rgba(255,255,255,0.08)';
      textComposerClose.style.color = '#edf3fb';
      textComposerClose.style.font = 'inherit';
      textComposerClose.style.fontWeight = '700';
      textComposerClose.style.cursor = 'pointer';

      const textComposerInput = document.createElement('textarea');
      textComposerInput.rows = 3;
      textComposerInput.placeholder = 'Type a note';
      textComposerInput.style.width = '100%';
      textComposerInput.style.minHeight = '86px';
      textComposerInput.style.boxSizing = 'border-box';
      textComposerInput.style.resize = 'none';
      textComposerInput.style.borderRadius = '12px';
      textComposerInput.style.border = '1px solid rgba(103, 209, 255, 0.24)';
      textComposerInput.style.padding = '10px 12px';
      textComposerInput.style.background = 'rgba(255,255,255,0.06)';
      textComposerInput.style.color = '#eef4fb';
      textComposerInput.style.font = 'inherit';

      const textComposerActions = document.createElement('div');
      textComposerActions.style.display = 'grid';
      textComposerActions.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
      textComposerActions.style.gap = '8px';

      const textComposerSave = document.createElement('button');
      textComposerSave.textContent = 'Add text';
      const textComposerCancel = document.createElement('button');
      textComposerCancel.textContent = 'Cancel';

      [textComposerSave, textComposerCancel].forEach((button) => {
        button.style.border = '0';
        button.style.borderRadius = '10px';
        button.style.padding = '10px 12px';
        button.style.font = 'inherit';
        button.style.fontWeight = '700';
        button.style.cursor = 'pointer';
      });
      textComposerSave.style.background = 'linear-gradient(135deg, #6acfff 0%, #3b82ff 100%)';
      textComposerSave.style.color = '#041220';
      textComposerCancel.style.background = 'rgba(255,255,255,0.08)';
      textComposerCancel.style.color = '#edf3fb';

      textComposerActions.append(textComposerSave, textComposerCancel);
      textComposerHeader.append(textComposerLabel, textComposerClose);
      textComposer.append(textComposerHeader, textComposerInput, textComposerActions);
      stage.append(textComposer);

      const renderEditorAnnotations = () => {
        stage.querySelectorAll('[data-snapclip-annotation]').forEach((node) => node.remove());
        textBounds.clear();

        const drawBox = (
          annotation: { id?: string; x: number; y: number; width: number; height: number },
          draft = false,
        ) => {
          const isSelected = !draft && annotation.id === selectedAnnotationId;
          const node = document.createElement('div');
          node.dataset.snapclipAnnotation = 'true';
          node.style.position = 'absolute';
          node.style.left = `${annotation.x}%`;
          node.style.top = `${annotation.y}%`;
          node.style.width = `${annotation.width}%`;
          node.style.height = `${annotation.height}%`;
          node.style.border = `3px ${draft ? 'dashed' : 'solid'} ${annotationColor}`;
          node.style.borderRadius = '12px';
          node.style.background = isSelected ? 'rgba(255, 138, 91, 0.1)' : 'rgba(255, 138, 91, 0.06)';
          node.style.boxShadow = isSelected ? '0 0 0 2px rgba(255, 214, 196, 0.4)' : 'none';
          node.style.pointerEvents = 'none';
          stage.append(node);

          if (isSelected) {
            const handle = document.createElement('div');
            handle.dataset.snapclipAnnotation = 'true';
            handle.style.position = 'absolute';
            handle.style.left = `calc(${annotation.x + annotation.width}% - 7px)`;
            handle.style.top = `calc(${annotation.y + annotation.height}% - 7px)`;
            handle.style.width = '14px';
            handle.style.height = '14px';
            handle.style.borderRadius = '999px';
            handle.style.background = '#fff4ee';
            handle.style.border = `3px solid ${annotationColor}`;
            handle.style.boxSizing = 'border-box';
            handle.style.pointerEvents = 'none';
            handle.style.boxShadow = '0 10px 20px rgba(0, 0, 0, 0.24)';
            stage.append(handle);
          }
        };

        const drawArrow = (
          annotation: { id?: string; startX: number; startY: number; endX: number; endY: number },
          draft = false,
        ) => {
          const isSelected = !draft && annotation.id === selectedAnnotationId;
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.dataset.snapclipAnnotation = 'true';
          svg.setAttribute('viewBox', '0 0 100 100');
          svg.setAttribute('preserveAspectRatio', 'none');
          svg.style.position = 'absolute';
          svg.style.inset = '0';
          svg.style.width = '100%';
          svg.style.height = '100%';
          svg.style.pointerEvents = 'none';

          const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
          const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
          const markerId = `arrowhead-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          marker.setAttribute('id', markerId);
          marker.setAttribute('markerWidth', '6');
          marker.setAttribute('markerHeight', '6');
          marker.setAttribute('refX', '5');
          marker.setAttribute('refY', '3');
          marker.setAttribute('orient', 'auto');
          const markerPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          markerPath.setAttribute('d', 'M0,0 L6,3 L0,6 z');
          markerPath.setAttribute('fill', annotationColor);
          marker.append(markerPath);
          defs.append(marker);

          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', String(annotation.startX));
          line.setAttribute('y1', String(annotation.startY));
          line.setAttribute('x2', String(annotation.endX));
          line.setAttribute('y2', String(annotation.endY));
          line.setAttribute('stroke', annotationColor);
          line.setAttribute('stroke-width', isSelected ? '0.95' : '0.7');
          line.setAttribute('stroke-linecap', 'round');
          if (draft) {
            line.setAttribute('stroke-dasharray', '2 1.5');
          } else {
            line.setAttribute('marker-end', `url(#${markerId})`);
            svg.append(defs);
          }

          svg.append(line);
          stage.append(svg);

          if (isSelected) {
            [
              { x: annotation.startX, y: annotation.startY },
              { x: annotation.endX, y: annotation.endY },
            ].forEach((point) => {
              const handle = document.createElement('div');
              handle.dataset.snapclipAnnotation = 'true';
              handle.style.position = 'absolute';
              handle.style.left = `calc(${point.x}% - 6px)`;
              handle.style.top = `calc(${point.y}% - 6px)`;
              handle.style.width = '12px';
              handle.style.height = '12px';
              handle.style.borderRadius = '999px';
              handle.style.background = '#fff4ee';
              handle.style.border = `3px solid ${annotationColor}`;
              handle.style.boxSizing = 'border-box';
              handle.style.pointerEvents = 'none';
              handle.style.boxShadow = '0 8px 18px rgba(0, 0, 0, 0.24)';
              stage.append(handle);
            });
          }
        };

        const drawText = (annotation: { id?: string; x: number; y: number; text: string }) => {
          const isSelected = annotation.id === selectedAnnotationId;
          const node = document.createElement('div');
          node.dataset.snapclipAnnotation = 'true';
          node.textContent = annotation.text;
          node.style.position = 'absolute';
          node.style.left = `${annotation.x}%`;
          node.style.top = `${annotation.y}%`;
          node.style.transform = 'translateY(-100%)';
          node.style.padding = '6px 10px';
          node.style.borderRadius = '10px';
          node.style.background = isSelected ? 'rgba(8, 15, 28, 0.96)' : 'rgba(8, 15, 28, 0.88)';
          node.style.border = `2px solid ${annotationColor}`;
          node.style.color = '#eef4fb';
          node.style.fontSize = '14px';
          node.style.fontWeight = '700';
          node.style.lineHeight = '1.35';
          node.style.pointerEvents = 'none';
          node.style.maxWidth = '58%';
          node.style.wordBreak = 'break-word';
          node.style.boxShadow = isSelected ? '0 0 0 2px rgba(255, 214, 196, 0.35)' : 'none';
          stage.append(node);

          if (annotation.id) {
            window.requestAnimationFrame(() => {
              const stageBounds = stage.getBoundingClientRect();
              const nodeBounds = node.getBoundingClientRect();
              textBounds.set(annotation.id!, {
                left: ((nodeBounds.left - stageBounds.left) / stageBounds.width) * 100,
                right: ((nodeBounds.right - stageBounds.left) / stageBounds.width) * 100,
                top: ((nodeBounds.top - stageBounds.top) / stageBounds.height) * 100,
                bottom: ((nodeBounds.bottom - stageBounds.top) / stageBounds.height) * 100,
              });
            });
          }
        };

        annotations.forEach((annotation) => {
          if (annotation.kind === 'box') {
            drawBox(annotation);
            return;
          }

          if (annotation.kind === 'arrow') {
            drawArrow(annotation);
            return;
          }

          drawText(annotation);
        });

        if (editorDraftShape?.kind === 'box') {
          drawBox(editorDraftShape, true);
        }

        if (editorDraftShape?.kind === 'arrow') {
          drawArrow(editorDraftShape, true);
        }

        renderSelectionHint();
        syncStageCursorBubble();
      };

      const closeTextComposer = (restoreFocus = true) => {
        pendingTextPoint = null;
        editingTextAnnotationId = null;
        textComposerInput.value = '';
        textComposer.style.display = 'none';
        composerDragOffset = null;
        if (isStageHovered) {
          syncStageCursorBubble();
        } else {
          hideCursorBubble();
        }
        if (restoreFocus) {
          stage.focus();
        }
      };

      const saveTextAnnotation = () => {
        const text = textComposerInput.value.trim();
        if (!pendingTextPoint || !text) {
          closeTextComposer();
          return;
        }

        const textPoint = pendingTextPoint;
        const annotationId = editingTextAnnotationId ?? `annotation_${Date.now()}`;
        if (editingTextAnnotationId) {
          annotations = annotations.map((annotation) =>
            annotation.id === editingTextAnnotationId && annotation.kind === 'text'
              ? {
                  ...annotation,
                  text,
                  x: textPoint.x,
                  y: textPoint.y,
                }
              : annotation,
          );
        } else {
          annotations = [
            ...annotations,
            {
              id: annotationId,
              kind: 'text',
              color: annotationColor,
              text,
              x: textPoint.x,
              y: textPoint.y,
            },
          ];
        }
        selectedAnnotationId = annotationId;
        renderEditorAnnotations();
        announce(editingTextAnnotationId ? 'Text annotation updated.' : 'Text annotation added.', 'success');
        setActionStatus(editingTextAnnotationId ? 'Text annotation updated.' : 'Text annotation added.', 'success');
        closeTextComposer();
        syncActiveTool();
      };

      handleEditorEscape = () => {
        if (textComposer.style.display !== 'none') {
          closeTextComposer();
          announce('Text annotation cancelled.');
          return true;
        }

        return false;
      };

      const openTextComposer = (clientX: number, clientY: number, bounds: DOMRect) => {
        const point = toPercentPoint(clientX, clientY, bounds);
        pendingTextPoint = point;

        const composerWidth = Math.min(280, Math.max(220, bounds.width * 0.32));
        const localX = clamp(clientX - bounds.left, 12, Math.max(12, bounds.width - composerWidth - 12));
        const preferredTop = clientY - bounds.top + 14;
        const maxTop = Math.max(12, bounds.height - 154);
        const localY = clamp(preferredTop, 12, maxTop);

        textComposer.style.width = `${composerWidth}px`;
        textComposer.style.left = `${localX}px`;
        textComposer.style.top = `${localY}px`;
        textComposer.style.display = 'grid';
        hideCursorBubble();
        textComposerInput.value = '';
        window.setTimeout(() => {
          textComposerInput.focus();
        }, 0);
      };

      const openExistingTextComposer = (annotation: Extract<ClipAnnotation, { kind: 'text' }>) => {
        const bounds = stage.getBoundingClientRect();
        editingTextAnnotationId = annotation.id;
        pendingTextPoint = { x: annotation.x, y: annotation.y };
        const composerWidth = Math.min(280, Math.max(220, bounds.width * 0.32));
        const localX = clamp((annotation.x / 100) * bounds.width, 12, Math.max(12, bounds.width - composerWidth - 12));
        const preferredTop = (annotation.y / 100) * bounds.height + 14;
        const maxTop = Math.max(12, bounds.height - 154);
        const localY = clamp(preferredTop, 12, maxTop);

        textComposer.style.width = `${composerWidth}px`;
        textComposer.style.left = `${localX}px`;
        textComposer.style.top = `${localY}px`;
        textComposer.style.display = 'grid';
        hideCursorBubble();
        textComposerInput.value = annotation.text;
        window.setTimeout(() => {
          textComposerInput.focus();
          textComposerInput.select();
        }, 0);
      };

      const clampComposerPosition = (left: number, top: number) => {
        const width = textComposer.offsetWidth || 280;
        const height = textComposer.offsetHeight || 170;
        return {
          left: clamp(left, 12, Math.max(12, boundsCache().width - width - 12)),
          top: clamp(top, 12, Math.max(12, boundsCache().height - height - 12)),
        };
      };

      const boundsCache = () => stage.getBoundingClientRect();

      const translateAnnotation = (annotation: ClipAnnotation, deltaX: number, deltaY: number): ClipAnnotation => {
        if (annotation.kind === 'box') {
          return {
            ...annotation,
            x: clamp(annotation.x + deltaX, 0, 100 - annotation.width),
            y: clamp(annotation.y + deltaY, 0, 100 - annotation.height),
          };
        }

        if (annotation.kind === 'text') {
          return {
            ...annotation,
            x: clamp(annotation.x + deltaX, 0, 100),
            y: clamp(annotation.y + deltaY, 6, 100),
          };
        }

        const minX = Math.min(annotation.startX, annotation.endX);
        const maxX = Math.max(annotation.startX, annotation.endX);
        const minY = Math.min(annotation.startY, annotation.endY);
        const maxY = Math.max(annotation.startY, annotation.endY);
        const safeDeltaX = clamp(deltaX, -minX, 100 - maxX);
        const safeDeltaY = clamp(deltaY, -minY, 100 - maxY);

        return {
          ...annotation,
          startX: annotation.startX + safeDeltaX,
          endX: annotation.endX + safeDeltaX,
          startY: annotation.startY + safeDeltaY,
          endY: annotation.endY + safeDeltaY,
        };
      };

      const distanceToSegment = (
        pointX: number,
        pointY: number,
        startX: number,
        startY: number,
        endX: number,
        endY: number,
      ) => {
        const dx = endX - startX;
        const dy = endY - startY;
        if (dx === 0 && dy === 0) {
          return Math.hypot(pointX - startX, pointY - startY);
        }

        const t = clamp(((pointX - startX) * dx + (pointY - startY) * dy) / (dx * dx + dy * dy), 0, 1);
        const projectionX = startX + t * dx;
        const projectionY = startY + t * dy;
        return Math.hypot(pointX - projectionX, pointY - projectionY);
      };

      const hitTestAnnotation = (
        point: { x: number; y: number },
      ): {
        annotation: ClipAnnotation;
        mode: 'move' | 'resize-box' | 'resize-arrow-start' | 'resize-arrow-end';
      } | null =>
        [...annotations]
          .reverse()
          .map((annotation) => {
            if (annotation.kind === 'box') {
              const nearCorner =
                Math.abs(point.x - (annotation.x + annotation.width)) <= 2 &&
                Math.abs(point.y - (annotation.y + annotation.height)) <= 2;
              if (nearCorner) {
                return { annotation, mode: 'resize-box' as const };
              }
              if (
                point.x >= annotation.x &&
                point.x <= annotation.x + annotation.width &&
                point.y >= annotation.y &&
                point.y <= annotation.y + annotation.height
              ) {
                return { annotation, mode: 'move' as const };
              }
              return null;
            }

            if (annotation.kind === 'text') {
              const bounds = textBounds.get(annotation.id);
              const left = bounds?.left ?? annotation.x;
              const right = bounds?.right ?? Math.min(100, annotation.x + 26);
              const top = bounds?.top ?? Math.max(0, annotation.y - 8);
              const bottom = bounds?.bottom ?? annotation.y + 4;
              if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) {
                return { annotation, mode: 'move' as const };
              }
              return null;
            }

            if (Math.hypot(point.x - annotation.startX, point.y - annotation.startY) <= 2) {
              return { annotation, mode: 'resize-arrow-start' as const };
            }
            if (Math.hypot(point.x - annotation.endX, point.y - annotation.endY) <= 2) {
              return { annotation, mode: 'resize-arrow-end' as const };
            }

            if (
              distanceToSegment(
                point.x,
                point.y,
                annotation.startX,
                annotation.startY,
                annotation.endX,
                annotation.endY,
              ) <= 2.2
            ) {
              return { annotation, mode: 'move' as const };
            }

            return null;
          })
          .find((result) => result !== null) ?? null;

      const syncStageCursorBubble = (clientX?: number, clientY?: number) => {
        if (typeof clientX === 'number' && typeof clientY === 'number') {
          lastStagePointer = { clientX, clientY };
        }

        if (!isStageHovered || railMode === 'details' || textComposer.style.display !== 'none') {
          hideCursorBubble();
          return;
        }

        const pointer = lastStagePointer;
        if (!pointer) {
          hideCursorBubble();
          return;
        }

        const label =
          editorDraftShape?.kind === 'box'
            ? describeStageCursor()
            : '';
        showCursorBubble(label, pointer.clientX, pointer.clientY);
      };

      const toPercentPoint = (clientX: number, clientY: number, bounds: DOMRect) => ({
        x: (clamp(clientX - bounds.left, 0, bounds.width) / bounds.width) * 100,
        y: (clamp(clientY - bounds.top, 0, bounds.height) / bounds.height) * 100,
      });

      const toPercentRect = (
        startX: number,
        startY: number,
        clientX: number,
        clientY: number,
        bounds: DOMRect,
      ) => {
        const endX = clamp(clientX - bounds.left, 0, bounds.width);
        const endY = clamp(clientY - bounds.top, 0, bounds.height);
        const normalizedX = Math.min(startX, endX);
        const normalizedY = Math.min(startY, endY);
        const width = Math.abs(endX - startX);
        const height = Math.abs(endY - startY);

        return {
          x: (normalizedX / bounds.width) * 100,
          y: (normalizedY / bounds.height) * 100,
          width: (width / bounds.width) * 100,
          height: (height / bounds.height) * 100,
        };
      };

      const removeLastAnnotation = () => {
        closeTextComposer(false);
        annotations = annotations.slice(0, -1);
        selectedAnnotationId = annotations.at(-1)?.id ?? null;
        renderEditorAnnotations();
      };

      const removeSelectedAnnotation = () => {
        if (!selectedAnnotationId) {
          removeLastAnnotation();
          return;
        }

        closeTextComposer(false);
        annotations = annotations.filter((annotation) => annotation.id !== selectedAnnotationId);
        selectedAnnotationId = annotations.at(-1)?.id ?? null;
        renderEditorAnnotations();
      };

      toolUndoButton.addEventListener('click', removeLastAnnotation);

      const syncRailMode = () => {
        const showDetails = railMode === 'details';
        contentGrid.style.gridTemplateColumns = showDetails ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(420px, 480px)';
        mainColumn.style.display = showDetails ? 'none' : 'grid';
        sideRail.style.display = showDetails ? 'none' : 'grid';
        composePanel.style.display = showDetails ? 'none' : 'grid';
        debugWorkspace.style.display = showDetails ? 'grid' : 'none';
        detailsButton.textContent = 'Debug info';
        if (showDetails) {
          hideCursorBubble();
          return;
        }
        syncStageCursorBubble();
      };

      detailsButton.addEventListener('click', () => {
        railMode = 'details';
        syncRailMode();
        debugWorkspace.scrollTop = 0;
        detailsBackButton.focus();
        setActionStatus('Showing debug report.');
      });

      detailsBackButton.addEventListener('click', () => {
        railMode = 'compose';
        syncRailMode();
        noteField.focus();
        setActionStatus('Back to editor.');
      });

      copyDebugButton.addEventListener('click', () => {
        void flashButtonState(copyDebugButton, 'Copy report', 'Copying...', () =>
          copyTextToClipboard(buildDebugReportText())
        )
          .then(() => {
            announce('Debug report copied to your clipboard.', 'success');
            setActionStatus('Debug report copied.', 'success');
          })
          .catch((error) => {
            setActionStatus('Debug report copy failed.', 'error');
            announce(
              error instanceof Error
                ? `${error.message} Try Cmd/Ctrl+C after focusing the debug report button again.`
                : 'Debug report copy failed. Try Cmd/Ctrl+C again.',
              'error',
            );
          });
      });

      copyButton.addEventListener('click', () => {
        void flashButtonState(copyButton, 'Copy image', 'Copying...', () =>
          copyImageToClipboard(clipDataUrl)
        )
          .then(() => {
            announce('Image copied to your clipboard.', 'success');
            setActionStatus('Image copied.', 'success');
          })
          .catch((error) => {
            setActionStatus('Image copy failed.', 'error');
            announce(
              error instanceof Error
                ? `${error.message} Try Cmd/Ctrl+C after clicking the image.`
                : 'Image copy failed. Try Cmd/Ctrl+C after clicking the image.',
              'error',
            );
          });
      });

      copyInstructionsButton.addEventListener('click', () => {
        const instructionsText = noteField.value.trim();
        if (!instructionsText) {
          setActionStatus('Add a prompt before copying instructions.', 'error');
          announce('Add a prompt first, then copy the instructions.', 'error');
          return;
        }

        void flashButtonState(copyInstructionsButton, 'Copy prompt', 'Copying...', () =>
          copyTextToClipboard(instructionsText)
        )
          .then(() => {
            announce('Instructions copied to your clipboard.', 'success');
            setActionStatus('Instructions copied.', 'success');
          })
          .catch((error) => {
            setActionStatus('Instructions copy failed.', 'error');
            announce(
              error instanceof Error
                ? `${error.message} Try Cmd/Ctrl+C after focusing the instructions again.`
                : 'Instructions copy failed. Try Cmd/Ctrl+C again.',
              'error',
            );
          });
      });

      copySummaryButton.addEventListener('click', () => {
        const issueLines = recentMessages.length
          ? recentMessages.map((line) => `- ${line}`).join('\n')
          : '- No immediate errors or failed requests captured.';
        const summaryText = [
          `# ${clipTitle}`,
          '',
          noteField.value.trim() ? `Instructions:\n${noteField.value.trim()}` : '',
          '',
          `Page: ${pageContext.title}`,
          `URL: ${pageContext.url}`,
          `Viewport: ${pageContext.viewport.width} x ${pageContext.viewport.height} @ ${pageContext.viewport.dpr}x`,
          `Clip area: ${Math.round(rect.width)} x ${Math.round(rect.height)} at ${Math.round(rect.x)}, ${Math.round(rect.y)}`,
          runtimeSummary
            ? `Runtime summary: ${runtimeSummary.eventCount} events, ${runtimeSummary.errorCount} errors, ${runtimeSummary.warningCount} warnings, ${runtimeSummary.failedRequestCount} failed requests, ${runtimeSummary.slowRequestCount} slow requests`
            : 'Runtime summary: no monitor data captured.',
          chromeDebugger
            ? chromeDebugger.attachError
              ? `Chrome debugger snapshot: unavailable (${chromeDebugger.attachError})`
              : `Chrome debugger snapshot: ${chromeDebugger.frameCount} frames, ${chromeDebugger.performance.nodes ?? 0} nodes, ${chromeDebugger.logs.length} logs, ${chromeDebugger.network.length} requests`
            : 'Chrome debugger snapshot: not attached.',
          pageContext.domSummary.selectedText ? `Selected text: ${pageContext.domSummary.selectedText}` : '',
          '',
          'Recent issues:',
          issueLines,
        ]
          .filter(Boolean)
          .join('\n');

        void flashButtonState(copySummaryButton, 'Copy packet', 'Copying...', () =>
          copyPacketToClipboard(clipDataUrl, summaryText)
        )
          .then(() => {
            announce('Packet copied with image and summary.', 'success');
            setActionStatus('Packet copied with image and summary.', 'success');
          })
          .catch((error) => {
            setActionStatus('Packet copy failed.', 'error');
            announce(
              error instanceof Error
                ? `${error.message} Try Cmd/Ctrl+C after focusing the summary action again.`
                : 'Summary copy failed. Try Cmd/Ctrl+C again.',
              'error',
            );
          });
      });

      closeButton.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });

      closeButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleEditorEscape = null;
        teardownOverlay();
      });

      cancelButton.addEventListener('click', () => {
        handleEditorEscape = null;
        teardownOverlay();
      });

      const syncActiveTool = () => {
        const setToolState = (button: HTMLButtonElement, isActive: boolean) => {
          button.style.background = isActive
            ? 'linear-gradient(135deg, rgba(106, 207, 255, 0.24) 0%, rgba(59, 130, 255, 0.2) 100%)'
            : 'rgba(255,255,255,0.08)';
          button.style.color = isActive ? '#f3fbff' : '#d7e4f5';
          button.style.boxShadow = isActive ? '0 0 0 1px rgba(103, 209, 255, 0.42) inset' : 'none';
        };

        setToolState(toolTextButton, activeTool === 'text');
        setToolState(toolBoxButton, activeTool === 'box');
        setToolState(toolArrowButton, activeTool === 'arrow');
        stage.style.cursor = 'none';
        renderSelectionHint();
        syncStageCursorBubble();
      };

      const setActionStatus = (
        message: string,
        tone: 'default' | 'success' | 'error' = 'default',
      ) => {
        actionStatus.textContent = message;
        actionStatus.style.display = 'flex';

        if (tone === 'success') {
          actionStatus.style.background = 'rgba(20, 96, 62, 0.92)';
          actionStatus.style.color = '#effff6';
          return;
        }

        if (tone === 'error') {
          actionStatus.style.background = 'rgba(105, 31, 40, 0.92)';
          actionStatus.style.color = '#fff1f4';
          return;
        }

        actionStatus.style.background = 'rgba(255,255,255,0.06)';
        actionStatus.style.color = '#dbe8f8';
      };

      type OverlayBridgeWorkspace = {
        id: string;
        name: string;
        sessionCount: number;
      };

      type OverlayBridgeSession = {
        id: string;
        workspaceId: string;
        workspaceName?: string | null;
        target: 'claude' | 'codex';
        label: string;
        surface?: string;
        pendingApprovalCount?: number;
      };

      type AgentPackagePreset = 'image' | 'packet' | 'debug';

      const claudeSessionSurfaces: Array<{
        mode: 'rail';
        root: HTMLDivElement;
      }> = [{ mode: 'rail', root: claudeRailStrip }];
      let bridgeWorkspaces: OverlayBridgeWorkspace[] = [];
      let bridgeSessions: OverlayBridgeSession[] = [];
      let selectedWorkspaceId = '';
      let selectedClaudeSessionId = '';
      let bridgeStatusMessage = '';
      let bridgeStatusTone: 'default' | 'success' | 'error' = 'default';
      let bridgeDiscoveryMode: 'workspace' | 'active' = 'workspace';
      let bridgeHealthState: 'unknown' | 'unavailable' | 'ready' | 'claude_unavailable' | 'hooks_missing' = 'unknown';
      let bridgeHealthSummary = '';
      let isBridgeLoading = false;
      let isBridgeSending = false;
      let activeClaudeSessionId = '';
      let successfulClaudeSessionId = '';
      let pendingPackageSessionId = '';
      let bridgeRequestToken = 0;

      const styleClaudeStatus = (
        node: HTMLDivElement,
        tone: 'default' | 'success' | 'error',
      ) => {
        if (tone === 'success') {
          node.style.background = 'rgba(20, 96, 62, 0.22)';
          node.style.color = '#dffbed';
          node.style.border = '1px solid rgba(83, 211, 149, 0.24)';
          return;
        }

        if (tone === 'error') {
          node.style.background = 'rgba(105, 31, 40, 0.24)';
          node.style.color = '#ffe4ea';
          node.style.border = '1px solid rgba(255, 119, 143, 0.24)';
          return;
        }

        node.style.background = 'rgba(255,255,255,0.04)';
        node.style.color = '#b7c4da';
        node.style.border = '1px solid rgba(255,255,255,0.08)';
      };

      const syncSaveButtonLabel = () => {
        saveButton.textContent = currentClip ? 'Save changes' : 'Save clip';
      };

      const readStoredBridgeSelection = async () => {
        try {
          const result = await chrome.storage.local.get([
            bridgeSelectedWorkspaceStorageKey,
            bridgeSelectedSessionStorageKey,
          ]);

          return {
            workspaceId:
              typeof result[bridgeSelectedWorkspaceStorageKey] === 'string'
                ? result[bridgeSelectedWorkspaceStorageKey]
                : '',
            sessionId:
              typeof result[bridgeSelectedSessionStorageKey] === 'string'
                ? result[bridgeSelectedSessionStorageKey]
                : '',
          };
        } catch {
          return {
            workspaceId: '',
            sessionId: '',
          };
        }
      };

      const persistBridgeSelection = async (workspaceId: string, sessionId: string) => {
        try {
          await chrome.storage.local.set({
            [bridgeSelectedWorkspaceStorageKey]: workspaceId,
            [bridgeSelectedSessionStorageKey]: sessionId,
          });
        } catch (error) {
          console.warn('LLM Clip could not persist the selected Claude session.', error);
        }
      };

      const getSessionTaskStatusMessage = (
        task: { target?: string; delivery: { state: string; error?: string | null } },
        sessionLabel: string,
      ) => {
        const targetLabel = task.target === 'codex' ? 'Codex' : 'Claude';
        if (task.delivery.state === 'delivered') {
          return `Sent to ${sessionLabel}. The local incident packet was preserved.`;
        }

        if (task.delivery.state === 'failed_after_bundle_creation') {
          return `${targetLabel} delivery to ${sessionLabel} failed after bundle creation. The local packet was preserved.`;
        }

        if (task.delivery.state === 'bundle_created') {
          return `The incident packet for ${sessionLabel} was created locally.`;
        }

        return `Sending to ${sessionLabel}...`;
      };

      const getPackagePresetConfig = (preset: AgentPackagePreset) => {
        if (preset === 'image') {
          return {
            label: 'Image focus',
            detail: 'Send the screenshot and annotations with lean structured evidence.',
            scope: 'active_clip' as const,
            evidenceProfile: 'lean' as const,
          };
        }

        if (preset === 'debug') {
          return {
            label: 'Debug packet',
            detail: 'Send the clip with the fullest runtime and debugger evidence we keep locally.',
            scope: 'active_clip' as const,
            evidenceProfile: 'full' as const,
          };
        }

        return {
          label: 'Clip packet',
          detail: 'Send the recommended clip packet with image, annotations, and balanced evidence.',
          scope: 'active_clip' as const,
          evidenceProfile: 'balanced' as const,
        };
      };

      const renderClaudeSessionSurfaces = () => {
        claudeSessionSurfaces.forEach(({ mode, root }) => {
          root.replaceChildren();

          const head = document.createElement('div');
          head.style.display = 'flex';
          head.style.alignItems = 'center';
          head.style.justifyContent = 'space-between';
          head.style.gap = '10px';
          head.style.flexWrap = 'wrap';

          const labelBlock = document.createElement('div');
          labelBlock.style.display = 'grid';
          labelBlock.style.gap = '4px';

          const eyebrow = document.createElement('div');
          eyebrow.textContent = 'SEND TO AGENT';
          eyebrow.style.color = '#88d5ff';
          eyebrow.style.fontSize = mode === 'rail' ? '11px' : '10px';
          eyebrow.style.fontWeight = '700';
          eyebrow.style.letterSpacing = '0.08em';
          eyebrow.style.textTransform = 'uppercase';

          const copy = document.createElement('div');
          copy.textContent =
            mode === 'rail'
              ? 'Send this clip one-way into a live Claude or Codex session when the local companion is ready.'
              : 'Send this clip one-way from the debug report.';
          copy.style.color = '#b7c4da';
          copy.style.fontSize = mode === 'rail' ? '12px' : '11px';
          copy.style.lineHeight = '1.45';

          labelBlock.append(eyebrow, copy);

          const controls = document.createElement('div');
          controls.style.display = 'flex';
          controls.style.alignItems = 'center';
          controls.style.gap = '8px';
          controls.style.flexWrap = 'wrap';

          if (bridgeDiscoveryMode === 'workspace' && bridgeWorkspaces.length > 1) {
            const workspaceSelect = document.createElement('select');
            workspaceSelect.value = selectedWorkspaceId;
            workspaceSelect.disabled = isBridgeLoading || isBridgeSending;
            workspaceSelect.style.borderRadius = '10px';
            workspaceSelect.style.border = '1px solid rgba(117, 204, 255, 0.2)';
            workspaceSelect.style.background = 'rgba(6, 12, 22, 0.92)';
            workspaceSelect.style.color = '#edf3fb';
            workspaceSelect.style.font = 'inherit';
            workspaceSelect.style.fontSize = '12px';
            workspaceSelect.style.padding = '8px 10px';

            bridgeWorkspaces.forEach((workspace) => {
              const option = document.createElement('option');
              option.value = workspace.id;
              option.textContent = workspace.name;
              workspaceSelect.append(option);
            });

            workspaceSelect.addEventListener('change', () => {
              void changeBridgeWorkspace(workspaceSelect.value);
            });
            controls.append(workspaceSelect);
          } else if (bridgeDiscoveryMode === 'workspace' && bridgeWorkspaces.length === 1) {
            const workspacePill = document.createElement('div');
            workspacePill.textContent = bridgeWorkspaces[0]!.name;
            workspacePill.style.padding = '8px 10px';
            workspacePill.style.borderRadius = '999px';
            workspacePill.style.background = 'rgba(255,255,255,0.06)';
            workspacePill.style.color = '#dbe8f8';
            workspacePill.style.fontSize = '12px';
            workspacePill.style.fontWeight = '700';
            controls.append(workspacePill);
          }

          const refreshButton = document.createElement('button');
          refreshButton.type = 'button';
          refreshButton.textContent = isBridgeLoading ? 'Refreshing...' : 'Refresh';
          refreshButton.disabled = isBridgeLoading || isBridgeSending;
          refreshButton.style.border = '0';
          refreshButton.style.borderRadius = '10px';
          refreshButton.style.padding = '8px 10px';
          refreshButton.style.font = 'inherit';
          refreshButton.style.fontSize = '12px';
          refreshButton.style.fontWeight = '700';
          refreshButton.style.cursor = 'pointer';
          refreshButton.style.background = 'rgba(255,255,255,0.08)';
          refreshButton.style.color = '#edf3fb';
          refreshButton.addEventListener('click', () => {
            void refreshBridgeSessions(true);
          });
          controls.append(refreshButton);

          head.append(labelBlock, controls);

          const sessionRow = document.createElement('div');
          sessionRow.style.display = 'flex';
          sessionRow.style.gap = '8px';
          sessionRow.style.flexWrap = 'wrap';

          if (bridgeSessions.length) {
            bridgeSessions.forEach((session) => {
              const sessionButton = document.createElement('button');
              sessionButton.type = 'button';
              const isSendingSession = isBridgeSending && activeClaudeSessionId === session.id;
              const isSentSession = !isBridgeSending && successfulClaudeSessionId === session.id;
              sessionButton.textContent = isSendingSession ? 'Sending...' : isSentSession ? 'Sent' : session.label;
              sessionButton.disabled = isBridgeLoading || isBridgeSending;
              sessionButton.style.border = '1px solid transparent';
              sessionButton.style.borderRadius = '12px';
              sessionButton.style.padding = '10px 12px';
              sessionButton.style.font = 'inherit';
              sessionButton.style.fontSize = '12px';
              sessionButton.style.fontWeight = '700';
              sessionButton.style.cursor = sessionButton.disabled ? 'default' : 'pointer';
              sessionButton.style.transition = 'background 120ms ease, border-color 120ms ease, color 120ms ease';
              sessionButton.style.background = isSentSession
                ? 'rgba(20, 96, 62, 0.3)'
                : selectedClaudeSessionId === session.id
                  ? 'rgba(83, 197, 255, 0.18)'
                  : 'rgba(255,255,255,0.08)';
              sessionButton.style.borderColor = isSentSession
                ? 'rgba(83, 211, 149, 0.28)'
                : selectedClaudeSessionId === session.id
                  ? 'rgba(83, 197, 255, 0.38)'
                  : 'rgba(255,255,255,0.08)';
              sessionButton.style.color = '#edf3fb';
              sessionButton.addEventListener('click', () => {
                if (isBridgeLoading || isBridgeSending) {
                  return;
                }

                selectedClaudeSessionId = session.id;
                selectedWorkspaceId = session.workspaceId || selectedWorkspaceId;
                successfulClaudeSessionId = '';
                pendingPackageSessionId = pendingPackageSessionId === session.id ? '' : session.id;
                bridgeStatusMessage = pendingPackageSessionId
                  ? ''
                  : `Choose what to send to ${session.label}.`;
                if (pendingPackageSessionId !== session.id) {
                  bridgeStatusMessage = `Choose what to send to ${session.label}.`;
                }
                bridgeStatusTone = 'default';
                void persistBridgeSelection(selectedWorkspaceId, selectedClaudeSessionId);
                renderClaudeSessionSurfaces();
              });
              sessionRow.append(sessionButton);
            });
          } else {
            const empty = document.createElement('div');
            empty.textContent = isBridgeLoading
              ? 'Loading live agent sessions...'
              : bridgeDiscoveryMode === 'active'
                ? 'No live agent sessions are open right now.'
                : selectedWorkspaceId
                ? 'No live agent sessions were found in the fallback workspace view.'
                : bridgeWorkspaces.length
                  ? 'No live sessions were found yet.'
                  : 'No live agent sessions were found.';
            empty.style.color = '#9db2cf';
            empty.style.fontSize = '12px';
            empty.style.lineHeight = '1.45';
            sessionRow.append(empty);
          }

          if (pendingPackageSessionId) {
            const pendingSession = bridgeSessions.find((session) => session.id === pendingPackageSessionId) ?? null;
            if (pendingSession) {
              const packagePanel = document.createElement('div');
              packagePanel.style.display = 'grid';
              packagePanel.style.gap = '10px';
              packagePanel.style.marginTop = '10px';
              packagePanel.style.padding = '12px';
              packagePanel.style.borderRadius = '14px';
              packagePanel.style.background = 'rgba(6, 12, 22, 0.56)';
              packagePanel.style.border = '1px solid rgba(117, 204, 255, 0.14)';

              const packageTitle = document.createElement('div');
              packageTitle.textContent = `Choose what to send to ${pendingSession.label}`;
              packageTitle.style.color = '#edf3fb';
              packageTitle.style.fontSize = '12px';
              packageTitle.style.fontWeight = '700';

              const packageGrid = document.createElement('div');
              packageGrid.style.display = 'grid';
              packageGrid.style.gap = '8px';

              (['image', 'packet', 'debug'] as AgentPackagePreset[]).forEach((preset) => {
                const presetConfig = getPackagePresetConfig(preset);
                const presetButton = document.createElement('button');
                presetButton.type = 'button';
                presetButton.disabled = isBridgeLoading || isBridgeSending;
                presetButton.style.display = 'grid';
                presetButton.style.gap = '4px';
                presetButton.style.textAlign = 'left';
                presetButton.style.border = '1px solid rgba(255,255,255,0.08)';
                presetButton.style.borderRadius = '12px';
                presetButton.style.padding = '10px 12px';
                presetButton.style.background = 'rgba(255,255,255,0.04)';
                presetButton.style.color = '#edf3fb';
                presetButton.style.cursor = presetButton.disabled ? 'default' : 'pointer';

                const presetLabel = document.createElement('div');
                presetLabel.textContent = presetConfig.label;
                presetLabel.style.fontSize = '12px';
                presetLabel.style.fontWeight = '700';

                const presetDetail = document.createElement('div');
                presetDetail.textContent = presetConfig.detail;
                presetDetail.style.fontSize = '11px';
                presetDetail.style.lineHeight = '1.45';
                presetDetail.style.color = '#b7c4da';

                presetButton.append(presetLabel, presetDetail);
                presetButton.addEventListener('click', () => {
                  void sendToAgentSession(pendingSession, preset);
                });
                packageGrid.append(presetButton);
              });

              const packageHint = document.createElement('div');
              packageHint.textContent = 'Replies stay in the target session. Snapclip only sends the local bundle one-way.';
              packageHint.style.color = '#9db2cf';
              packageHint.style.fontSize = '11px';
              packageHint.style.lineHeight = '1.45';

              const packageDismiss = document.createElement('button');
              packageDismiss.type = 'button';
              packageDismiss.textContent = 'Cancel';
              packageDismiss.style.justifySelf = 'start';
              packageDismiss.style.border = '0';
              packageDismiss.style.borderRadius = '10px';
              packageDismiss.style.padding = '8px 10px';
              packageDismiss.style.font = 'inherit';
              packageDismiss.style.fontSize = '12px';
              packageDismiss.style.fontWeight = '700';
              packageDismiss.style.cursor = 'pointer';
              packageDismiss.style.background = 'rgba(255,255,255,0.08)';
              packageDismiss.style.color = '#edf3fb';
              packageDismiss.addEventListener('click', () => {
                pendingPackageSessionId = '';
                bridgeStatusMessage = '';
                bridgeStatusTone = 'default';
                renderClaudeSessionSurfaces();
              });

              packagePanel.append(packageTitle, packageGrid, packageHint, packageDismiss);
              root.append(head, sessionRow, packagePanel);
            }
          }

          const status = document.createElement('div');
          status.style.display = 'block';
          status.style.padding = '9px 10px';
          status.style.borderRadius = '12px';
          status.style.fontSize = '12px';
          status.style.fontWeight = '600';
          status.style.lineHeight = '1.45';
          const hasLiveBridgeSessions = bridgeSessions.length > 0;
          let defaultBridgeStatus = 'Start the local companion to enable one-way agent handoff.';
          if (hasLiveBridgeSessions) {
            defaultBridgeStatus = selectedClaudeSessionId
              ? 'A live agent session is ready. Send includes the screenshot, annotated image, and local evidence packet.'
              : 'Live agent sessions were found and stay local unless you send them. The handoff includes the screenshot, annotated image, and local evidence packet.';
          } else if (bridgeHealthState === 'unavailable') {
            defaultBridgeStatus = 'Install or start the local companion to send clips directly into a live agent session.';
          } else if (bridgeHealthState === 'claude_unavailable') {
            defaultBridgeStatus =
              'The local companion is running, but Claude CLI discovery is not available here yet. Codex sessions may still appear if local state is available.';
          } else if (bridgeHealthState === 'hooks_missing') {
            defaultBridgeStatus = 'The local companion is running. Install Claude hooks to keep Claude sessions discoverable automatically.';
          } else if (bridgeHealthSummary) {
            defaultBridgeStatus = bridgeHealthSummary;
          } else if (bridgeDiscoveryMode === 'active') {
            defaultBridgeStatus = 'Live sessions were discovered directly from the local bridge.';
          } else if (bridgeWorkspaces.length) {
            defaultBridgeStatus = 'Live sessions are discovered through the local bridge and stay local unless you send them.';
          }
          status.textContent = bridgeStatusMessage || defaultBridgeStatus;
          styleClaudeStatus(status, bridgeStatusTone);

          if (!pendingPackageSessionId || !bridgeSessions.find((session) => session.id === pendingPackageSessionId)) {
            root.append(head, sessionRow, status);
          } else {
            root.append(status);
          }
        });
      };

      const changeBridgeWorkspace = async (workspaceId: string) => {
        selectedWorkspaceId = workspaceId;
        selectedClaudeSessionId = '';
        successfulClaudeSessionId = '';
        pendingPackageSessionId = '';
        bridgeStatusMessage = '';
        bridgeStatusTone = 'default';
        renderClaudeSessionSurfaces();
        await persistBridgeSelection(selectedWorkspaceId, '');
        await refreshBridgeSessions(false);
      };

      const refreshBridgeSessions = async (reloadWorkspaces: boolean) => {
        const requestToken = ++bridgeRequestToken;
        isBridgeLoading = true;
        bridgeStatusMessage = '';
        bridgeStatusTone = 'default';
        pendingPackageSessionId = '';
        renderClaudeSessionSurfaces();

        try {
          const storedSelection = await readStoredBridgeSelection();
          const healthResponse = await chrome.runtime.sendMessage({
            type: 'get-bridge-health',
          });

          if (!healthResponse?.ok || !healthResponse.health) {
            throw new Error(healthResponse?.error || 'The local companion is unavailable.');
          }

          const bridgeHealth = healthResponse.health;
          bridgeHealthSummary = bridgeHealth.claude.cliAvailable
            ? bridgeHealth.claude.hookInstalled
              ? 'Local companion connected.'
              : 'Local companion connected. Claude hooks are not installed yet.'
            : 'Local companion connected. Claude discovery is not available yet.';
          bridgeHealthState = !bridgeHealth.claude.cliAvailable
            ? 'claude_unavailable'
            : !bridgeHealth.claude.hookInstalled
              ? 'hooks_missing'
              : 'ready';

          if (reloadWorkspaces || bridgeSessions.length === 0) {
            const activeSessionResponse = await chrome.runtime.sendMessage({
              type: 'get-bridge-active-sessions',
            });

            if (activeSessionResponse?.ok) {
              const activeSessions = (activeSessionResponse.sessions ?? []).map((session: {
                id: string;
                workspaceId: string;
                workspaceName?: string | null;
                target: 'claude' | 'codex';
                label: string;
                surface?: string;
                pendingApprovalCount?: number;
              }) => ({
                id: session.id,
                workspaceId: session.workspaceId,
                workspaceName: session.workspaceName ?? null,
                target: session.target,
                label: session.label,
                surface: session.surface,
                pendingApprovalCount: session.pendingApprovalCount,
              }));

              if (requestToken !== bridgeRequestToken) {
                return;
              }

              bridgeDiscoveryMode = 'active';
              bridgeSessions = activeSessions;
              const activeWorkspaceMap = new Map<string, OverlayBridgeWorkspace>();
              activeSessions.forEach((session: OverlayBridgeSession) => {
                const existing = activeWorkspaceMap.get(session.workspaceId);
                if (existing) {
                  existing.sessionCount += 1;
                  return;
                }

                activeWorkspaceMap.set(session.workspaceId, {
                  id: session.workspaceId,
                  name: session.workspaceName || session.workspaceId,
                  sessionCount: 1,
                });
              });
              bridgeWorkspaces = Array.from(activeWorkspaceMap.values());
              selectedClaudeSessionId = pickSessionId(
                bridgeSessions,
                selectedClaudeSessionId || storedSelection.sessionId,
              );
              selectedWorkspaceId =
                bridgeSessions.find((session) => session.id === selectedClaudeSessionId)?.workspaceId ||
                bridgeSessions[0]?.workspaceId ||
                storedSelection.workspaceId ||
                '';
              await persistBridgeSelection(selectedWorkspaceId, selectedClaudeSessionId);
              return;
            }
          }

          if (reloadWorkspaces || bridgeWorkspaces.length === 0) {
            const workspaceResponse = await chrome.runtime.sendMessage({
              type: 'get-bridge-workspaces',
            });

            if (!workspaceResponse?.ok) {
              throw new Error(workspaceResponse?.error || 'The local bridge workspaces could not be loaded.');
            }

            if (requestToken !== bridgeRequestToken) {
              return;
            }

            bridgeWorkspaces = (workspaceResponse.workspaces ?? []).map((workspace: {
              id: string;
              name: string;
              sessionCount: number;
            }) => ({
              id: workspace.id,
              name: workspace.name,
              sessionCount: workspace.sessionCount,
            }));
            bridgeDiscoveryMode = 'workspace';

            selectedWorkspaceId = pickWorkspaceId(
              bridgeWorkspaces,
              selectedWorkspaceId || storedSelection.workspaceId,
            );
          }

          if (!selectedWorkspaceId) {
            bridgeSessions = [];
            bridgeStatusMessage = bridgeWorkspaces.length
              ? 'Pick a workspace to inspect live agent sessions.'
              : 'The local bridge returned no workspaces.';
            bridgeStatusTone = bridgeWorkspaces.length ? 'default' : 'error';
            pendingPackageSessionId = '';
            await persistBridgeSelection('', '');
            return;
          }

          const sessionResponse = await chrome.runtime.sendMessage({
            type: 'get-bridge-sessions',
            workspaceId: selectedWorkspaceId,
          });

          if (!sessionResponse?.ok) {
            throw new Error(sessionResponse?.error || 'The local bridge sessions could not be loaded.');
          }

          if (requestToken !== bridgeRequestToken) {
            return;
          }

          bridgeSessions = (sessionResponse.sessions ?? []).map((session: {
            id: string;
            workspaceId?: string;
            workspaceName?: string | null;
            target: 'claude' | 'codex';
            label: string;
            surface?: string;
            pendingApprovalCount?: number;
          }) => ({
            id: session.id,
            workspaceId: session.workspaceId || selectedWorkspaceId,
            workspaceName: session.workspaceName ?? null,
            target: session.target,
            label: session.label,
            surface: session.surface,
            pendingApprovalCount: session.pendingApprovalCount,
          }));
          selectedClaudeSessionId = pickSessionId(
            bridgeSessions,
            selectedClaudeSessionId || storedSelection.sessionId,
          );
          await persistBridgeSelection(selectedWorkspaceId, selectedClaudeSessionId);
          if (!bridgeSessions.some((session) => session.id === pendingPackageSessionId)) {
            pendingPackageSessionId = '';
          }
        } catch (error) {
          bridgeHealthState = 'unavailable';
          bridgeHealthSummary = '';
          bridgeWorkspaces = reloadWorkspaces ? [] : bridgeWorkspaces;
          bridgeSessions = [];
          pendingPackageSessionId = '';
          bridgeStatusMessage =
            error instanceof Error ? error.message : 'The local companion is unavailable.';
          bridgeStatusTone = 'error';
        } finally {
          if (requestToken === bridgeRequestToken) {
            isBridgeLoading = false;
            renderClaudeSessionSurfaces();
          }
        }
      };

      const sendToAgentSession = async (
        targetSession: OverlayBridgeSession,
        packagePreset: AgentPackagePreset,
      ) => {
        if (isBridgeSending) {
          return;
        }

        if (!targetSession.workspaceId && !selectedWorkspaceId) {
          return;
        }

        isBridgeSending = true;
        activeClaudeSessionId = targetSession.id;
        successfulClaudeSessionId = '';
        pendingPackageSessionId = '';
        selectedClaudeSessionId = targetSession.id;
        selectedWorkspaceId = targetSession.workspaceId || selectedWorkspaceId;
        const targetLabel = targetSession.target === 'codex' ? 'Codex' : 'Claude';
        const packageConfig = getPackagePresetConfig(packagePreset);
        bridgeStatusMessage = `Sending ${packageConfig.label.toLowerCase()} to ${targetSession.label}...`;
        bridgeStatusTone = 'default';
        renderClaudeSessionSurfaces();
        setActionStatus(`Sending ${packageConfig.label.toLowerCase()} to ${targetSession.label}...`);
        await persistBridgeSelection(selectedWorkspaceId, selectedClaudeSessionId);

        try {
          const response = await chrome.runtime.sendMessage({
            type: 'send-bridge-session',
            target: targetSession.target,
            workspaceId: selectedWorkspaceId,
            sessionId: targetSession.id,
            clipId: currentClip?.clipId,
            draftTitle: clipTitle,
            draftNote: noteField.value,
            draftAnnotations: annotations,
            intent: 'fix',
            scope: packageConfig.scope,
            evidenceProfile: packageConfig.evidenceProfile,
            ...(currentClip
              ? {}
              : {
                  newClip: {
                    clipMode,
                    title: clipTitle,
                    note: noteField.value,
                    imageDataUrl: clipDataUrl,
                    imageWidth: image.naturalWidth,
                    imageHeight: image.naturalHeight,
                    crop: rect,
                    pageContext,
                    runtimeContext,
                    annotations,
                  },
                }),
          });

          if (!response?.ok || !response.task) {
            throw new Error(response?.error || 'The local session handoff failed.');
          }

          const resultingClipId = currentClip?.clipId || response.session?.activeClipId || '';
          if (resultingClipId) {
            currentClip = {
              clipId: resultingClipId,
              title: clipTitle,
              note: noteField.value,
              annotations: annotations.map((annotation) => ({ ...annotation })),
              crop: rect,
            };
          }
          syncSaveButtonLabel();

          successfulClaudeSessionId = targetSession.id;
          bridgeStatusMessage = getSessionTaskStatusMessage(response.task, targetSession.label);
          bridgeStatusTone = response.task.delivery.state === 'failed_after_bundle_creation' ? 'error' : 'success';
          setActionStatus(
            bridgeStatusMessage,
            response.task.delivery.state === 'failed_after_bundle_creation' ? 'error' : 'success',
          );
          announce(bridgeStatusMessage, response.task.delivery.state === 'failed_after_bundle_creation' ? 'error' : 'success');
        } catch (error) {
          if (!currentClip) {
            try {
              const sessionResponse = await chrome.runtime.sendMessage({
                type: 'get-clip-session',
              });
              const recoveredClipId = sessionResponse?.ok ? sessionResponse.session?.activeClipId ?? '' : '';
              if (recoveredClipId) {
                currentClip = {
                  clipId: recoveredClipId,
                  title: clipTitle,
                  note: noteField.value,
                  annotations: annotations.map((annotation) => ({ ...annotation })),
                  crop: rect,
                };
                syncSaveButtonLabel();
              }
            } catch {
              // Ignore if we cannot recover the just-saved clip after a failed send.
            }
          }
          bridgeStatusMessage =
            error instanceof Error ? error.message : `The local ${targetLabel} session handoff failed.`;
          bridgeStatusTone = 'error';
          setActionStatus(`${targetLabel} session send failed.`, 'error');
          announce(bridgeStatusMessage, 'error');
        } finally {
          isBridgeSending = false;
          activeClaudeSessionId = '';
          renderClaudeSessionSurfaces();
        }
      };

      syncSaveButtonLabel();
      renderClaudeSessionSurfaces();
      void refreshBridgeSessions(true);

      const autoCopyClipImage = async () => {
        try {
          await copyImageToClipboard(clipDataUrl);
          setActionStatus('Image copied to clipboard. You can paste it right away.', 'success');
          announce('Image copied to your clipboard.', 'success');
        } catch (error) {
          console.warn('LLM Clip auto-copy failed; continuing without clipboard image.', error);
          setActionStatus('Clip ready. Clipboard copy was unavailable here. Use Copy image if needed.');
        }
      };

      const renderSelectionHint = () => {
        const selectedAnnotation = annotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null;

        selectionHint.style.display = 'block';

        if (!selectedAnnotation) {
          selectionHint.textContent =
            activeTool === 'text'
              ? 'Text tool active. Click the capture to place a note.'
              : activeTool === 'box'
                ? 'Box tool active. Drag across the capture to frame the important region.'
                : 'Arrow tool active. Drag to point at the exact issue.';
          return;
        }

        selectionHint.textContent =
          selectedAnnotation.kind === 'text'
            ? 'Text note selected. Drag to reposition it, or double-click to edit the copy.'
            : selectedAnnotation.kind === 'box'
              ? 'Box selected. Drag it to move, or drag the corner handle to resize.'
              : 'Arrow selected. Drag the line to move it, or drag an endpoint to retarget it.';
      };

      toolTextButton.addEventListener('click', () => {
        activeTool = 'text';
        syncActiveTool();
        setActionStatus('Text tool selected.');
      });

      toolBoxButton.addEventListener('click', () => {
        activeTool = 'box';
        syncActiveTool();
        setActionStatus('Box tool selected.');
      });

      toolArrowButton.addEventListener('click', () => {
        activeTool = 'arrow';
        syncActiveTool();
        setActionStatus('Arrow tool selected.');
      });

      textComposerSave.addEventListener('click', saveTextAnnotation);
      textComposerCancel.addEventListener('click', () => {
        closeTextComposer();
        setActionStatus('Text annotation cancelled.');
        announce('Text annotation cancelled.');
      });
      textComposerClose.addEventListener('click', () => {
        closeTextComposer();
        setActionStatus('Text annotation cancelled.');
        announce('Text annotation cancelled.');
      });
      textComposerHeader.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        composerDragOffset = {
          x: event.clientX - textComposer.offsetLeft,
          y: event.clientY - textComposer.offsetTop,
        };
        textComposerHeader.setPointerCapture(event.pointerId);
        textComposerHeader.style.cursor = 'grabbing';
      });
      textComposerHeader.addEventListener('pointermove', (event) => {
        if (!composerDragOffset) {
          return;
        }

        event.preventDefault();
        const nextPosition = clampComposerPosition(
          event.clientX - composerDragOffset.x,
          event.clientY - composerDragOffset.y,
        );
        textComposer.style.left = `${nextPosition.left}px`;
        textComposer.style.top = `${nextPosition.top}px`;
      });
      const finishComposerDrag = (event: PointerEvent) => {
        if (!composerDragOffset) {
          return;
        }

        if (textComposerHeader.hasPointerCapture(event.pointerId)) {
          textComposerHeader.releasePointerCapture(event.pointerId);
        }
        composerDragOffset = null;
        textComposerHeader.style.cursor = 'grab';
      };
      textComposerHeader.addEventListener('pointerup', finishComposerDrag);
      textComposerHeader.addEventListener('pointercancel', finishComposerDrag);
      textComposerInput.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          saveTextAnnotation();
          return;
        }

        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closeTextComposer();
          announce('Text annotation cancelled.');
        }
      });

      stage.addEventListener('focus', () => {
        stage.style.boxShadow = '0 0 0 1px rgba(115, 197, 255, 0.74), 0 0 0 4px rgba(115, 197, 255, 0.14)';
        stage.style.borderColor = 'rgba(115, 197, 255, 0.38)';
      });

      stage.addEventListener('blur', () => {
        stage.style.boxShadow = 'none';
        stage.style.borderColor = 'rgba(157, 177, 207, 0.16)';
      });

      stage.addEventListener('pointerenter', (event) => {
        isStageHovered = true;
        syncStageCursorBubble(event.clientX, event.clientY);
      });

      stage.addEventListener('pointerleave', (event) => {
        if (stage.hasPointerCapture(event.pointerId)) {
          return;
        }
        isStageHovered = false;
        hideCursorBubble();
      });

      stage.addEventListener('keydown', (event) => {
        if (event.key === 'Backspace' || event.key === 'Delete') {
          event.preventDefault();
          removeSelectedAnnotation();
          setActionStatus('Annotation removed.', 'success');
          announce('Annotation removed.', 'success');
          return;
        }

        if (event.key === 't' || event.key === 'T') {
          event.preventDefault();
          activeTool = 'text';
          syncActiveTool();
          setActionStatus('Text tool selected.');
          return;
        }

        if (event.key === 'b' || event.key === 'B') {
          event.preventDefault();
          activeTool = 'box';
          syncActiveTool();
          setActionStatus('Box tool selected.');
          return;
        }

        if (event.key === 'a' || event.key === 'A') {
          event.preventDefault();
          activeTool = 'arrow';
          syncActiveTool();
          setActionStatus('Arrow tool selected.');
        }
      });

      syncActiveTool();
      syncRailMode();
      setActionStatus('Box tool selected. Drag on the capture, or click an existing annotation to adjust it.');
      if (!initialClip) {
        void autoCopyClipImage();
      }

      stage.addEventListener('dblclick', (event) => {
        const target = event.target as HTMLElement;
        if (target.closest('button, textarea')) {
          return;
        }
        const bounds = stage.getBoundingClientRect();
        const percentPoint = toPercentPoint(event.clientX, event.clientY, bounds);
        const hitAnnotation = hitTestAnnotation(percentPoint);
        if (hitAnnotation?.annotation.kind === 'text') {
          event.preventDefault();
          event.stopPropagation();
          selectedAnnotationId = hitAnnotation.annotation.id;
          renderEditorAnnotations();
          openExistingTextComposer(hitAnnotation.annotation);
          setActionStatus('Editing text annotation.');
          announce('Update the text, then save it.');
        }
      });

      stage.addEventListener('pointerdown', (event) => {
        if ((event.target as HTMLElement).closest('button, textarea')) {
          return;
        }

        event.preventDefault();
        isStageHovered = true;
        syncStageCursorBubble(event.clientX, event.clientY);
        const bounds = stage.getBoundingClientRect();
        closeTextComposer(false);
        const percentPoint = toPercentPoint(event.clientX, event.clientY, bounds);
        const hitAnnotation = hitTestAnnotation(percentPoint);

        if (hitAnnotation) {
          selectedAnnotationId = hitAnnotation.annotation.id;
          movingAnnotation = {
            id: hitAnnotation.annotation.id,
            mode: hitAnnotation.mode,
            startPoint: percentPoint,
            original: hitAnnotation.annotation,
          };
          editorStartPoint = null;
          stage.setPointerCapture(event.pointerId);
          announce('Drag to reposition the annotation.');
          return;
        }

        if (activeTool === 'text') {
          selectedAnnotationId = null;
          editorStartPoint = null;
          openTextComposer(event.clientX, event.clientY, bounds);
          setActionStatus('Enter your prompt on the stage, then add it.');
          announce('Type your note, then add it to the clip.');
          return;
        }

        stage.setPointerCapture(event.pointerId);
        selectedAnnotationId = null;
        editorStartPoint = {
          x: clamp(event.clientX - bounds.left, 0, bounds.width),
          y: clamp(event.clientY - bounds.top, 0, bounds.height),
        };
      });

      stage.addEventListener('pointermove', (event) => {
        isStageHovered = true;
        syncStageCursorBubble(event.clientX, event.clientY);

        if (movingAnnotation) {
          const bounds = stage.getBoundingClientRect();
          const currentPoint = toPercentPoint(event.clientX, event.clientY, bounds);
          const deltaX = currentPoint.x - movingAnnotation.startPoint.x;
          const deltaY = currentPoint.y - movingAnnotation.startPoint.y;
          annotations = annotations.map((annotation) =>
            annotation.id === movingAnnotation?.id
              ? movingAnnotation.mode === 'move'
                ? translateAnnotation(movingAnnotation.original, deltaX, deltaY)
                : movingAnnotation.mode === 'resize-box' && movingAnnotation.original.kind === 'box'
                  ? {
                      ...movingAnnotation.original,
                      width: clamp(currentPoint.x - movingAnnotation.original.x, 1, 100 - movingAnnotation.original.x),
                      height: clamp(currentPoint.y - movingAnnotation.original.y, 1, 100 - movingAnnotation.original.y),
                    }
                  : movingAnnotation.mode === 'resize-arrow-start' && movingAnnotation.original.kind === 'arrow'
                    ? {
                        ...movingAnnotation.original,
                        startX: clamp(currentPoint.x, 0, 100),
                        startY: clamp(currentPoint.y, 0, 100),
                      }
                    : movingAnnotation.mode === 'resize-arrow-end' && movingAnnotation.original.kind === 'arrow'
                      ? {
                          ...movingAnnotation.original,
                          endX: clamp(currentPoint.x, 0, 100),
                          endY: clamp(currentPoint.y, 0, 100),
                        }
                      : annotation
              : annotation,
          );
          renderEditorAnnotations();
          return;
        }

        if (!editorStartPoint) {
          return;
        }

        const bounds = stage.getBoundingClientRect();
        if (activeTool === 'box') {
          editorDraftShape = {
            kind: 'box',
            ...toPercentRect(
              editorStartPoint.x,
              editorStartPoint.y,
              event.clientX,
              event.clientY,
              bounds,
            ),
          };
        } else if (activeTool === 'arrow') {
          const point = toPercentPoint(event.clientX, event.clientY, bounds);
          editorDraftShape = {
            kind: 'arrow',
            startX: (editorStartPoint.x / bounds.width) * 100,
            startY: (editorStartPoint.y / bounds.height) * 100,
            endX: point.x,
            endY: point.y,
          };
        }
        renderEditorAnnotations();
      });

      const finishAnnotation = (event: PointerEvent) => {
        if (movingAnnotation) {
          event.preventDefault();
          if (stage.hasPointerCapture(event.pointerId)) {
            stage.releasePointerCapture(event.pointerId);
          }
          selectedAnnotationId = movingAnnotation.id;
          movingAnnotation = null;
          setActionStatus('Annotation moved.', 'success');
          announce('Annotation moved.', 'success');
          syncStageCursorBubble(event.clientX, event.clientY);
          return;
        }

        if (!editorStartPoint) {
          return;
        }

        event.preventDefault();
        if (stage.hasPointerCapture(event.pointerId)) {
          stage.releasePointerCapture(event.pointerId);
        }

        const bounds = stage.getBoundingClientRect();
        const startPoint = editorStartPoint;
        editorStartPoint = null;
        editorDraftShape = null;

        if (activeTool === 'box') {
          const nextRect = toPercentRect(
            startPoint.x,
            startPoint.y,
            event.clientX,
            event.clientY,
            bounds,
          );
          if (nextRect.width >= 1 && nextRect.height >= 1) {
            const annotationId = `annotation_${Date.now()}`;
            annotations = [
              ...annotations,
              {
                id: annotationId,
                kind: 'box',
                color: annotationColor,
                ...nextRect,
              },
            ];
            selectedAnnotationId = annotationId;
          }
        } else if (activeTool === 'arrow') {
          const point = toPercentPoint(event.clientX, event.clientY, bounds);
          const startX = (startPoint.x / bounds.width) * 100;
          const startY = (startPoint.y / bounds.height) * 100;
          const distance = Math.hypot(point.x - startX, point.y - startY);
          if (distance >= 1.2) {
            const annotationId = `annotation_${Date.now()}`;
            annotations = [
              ...annotations,
              {
                id: annotationId,
                kind: 'arrow',
                color: annotationColor,
                startX,
                startY,
                endX: point.x,
                endY: point.y,
              },
            ];
            selectedAnnotationId = annotationId;
          }
        }

        renderEditorAnnotations();
        syncStageCursorBubble(event.clientX, event.clientY);
      };

      stage.addEventListener('pointerup', finishAnnotation);
      stage.addEventListener('pointercancel', finishAnnotation);

      saveButton.addEventListener('click', () => {
        void (async () => {
          try {
            saveButton.disabled = true;
            saveButton.textContent = 'Saving...';
            setActionStatus(currentClip ? 'Saving changes...' : 'Saving clip...');

            if (currentClip) {
              const [noteResponse, annotationsResponse] = await Promise.all([
                chrome.runtime.sendMessage({
                  type: 'update-clip-note',
                  clipId: currentClip.clipId,
                  note: noteField.value,
                }),
                chrome.runtime.sendMessage({
                  type: 'update-clip-annotations',
                  clipId: currentClip.clipId,
                  annotations,
                }),
              ]);

              if (!noteResponse?.ok) {
                throw new Error(noteResponse?.error || 'Clip note save failed.');
              }

              if (!annotationsResponse?.ok) {
                throw new Error(annotationsResponse?.error || 'Clip annotation save failed.');
              }
            } else {
              await persistCapturedClip({
                rect,
                clipDataUrl,
                imageWidth: image.naturalWidth,
                imageHeight: image.naturalHeight,
                title: clipTitle,
                note: noteField.value,
                annotations,
              });
            }

            try {
              await chrome.runtime.sendMessage({
                type: 'open-side-panel',
              });
            } catch {
              // If side panel opening is unavailable here, the saved clip still exists.
            }

            handleEditorEscape = null;
            teardownOverlay();
          } catch (error) {
            setActionStatus('Clip save failed.', 'error');
            announce(error instanceof Error ? error.message : 'Clip save failed.', 'error');
            saveButton.disabled = false;
            syncSaveButtonLabel();
          }
        })();
      });

      isSaving = false;
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Clip preparation failed.', 'error');
      isSaving = false;
      phase = 'select';
    }
  };

  document.documentElement.append(root);

  if (launchMode === 'saved-editor' && existingClip) {
    void openEditor(existingClip.crop, existingClip);
    return;
  }

  if (clipMode === 'visible') {
    const fullRect = {
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    };

    if (launchMode === 'quick-copy') {
      void completeQuickCopy(fullRect);
      return;
    }

    void openEditor(fullRect);
  }
}

function cancelMountedClipOverlay() {
  const cancel = (window as typeof window & { __llmClipCancelOverlay?: () => void }).__llmClipCancelOverlay;
  cancel?.();
}

export async function startClipWorkflow(
  clipMode: ClipMode,
  options?: {
    tabId?: number;
    windowId?: number;
    interactive?: boolean;
    launchMode?: ClipLaunchMode;
  },
): Promise<void> {
  const tab =
    typeof options?.tabId === 'number' ? await getSupportedTabById(options.tabId) : await getSupportedActiveTab();
  const tabId = tab.id;
  const windowId = ensureSupportedWindow(
    typeof options?.windowId === 'number' ? options.windowId : tab.windowId,
  );

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: cancelMountedClipOverlay,
    });
  } catch {
    // Ignore if there was no mounted overlay or the page was in-between states.
  }

  const loadPageContext = async (): Promise<PageContext> => {
    const [injectionResult] = await chrome.scripting.executeScript({
      target: { tabId },
      func: collectPageContext,
    });

    return pageContextSchema.parse(injectionResult.result);
  };

  let pageContext: PageContext;

  try {
    pageContext = await loadPageContext();
  } catch (error) {
    if (!isHostAccessError(error)) {
      throw error;
    }

    const accessResult = await requestTabHostAccess(tab, {
      interactive: options?.interactive ?? true,
    });
    const hostLabel = getUrlHostLabel(tab.url);

    if (accessResult === 'granted') {
      pageContext = await loadPageContext();
    } else if (accessResult === 'requested') {
      throw new Error(
        `LLM Clip needs access to ${hostLabel} before it can clip this page. Chrome should show a site access request in the tab. Approve it, then try again.`,
      );
    } else {
      throw new Error(
        `LLM Clip needs access to ${hostLabel} before it can clip this page. Grant site access and try again.`,
      );
    }
  }

  let runtimeContext: RuntimeContext | null = null;
  let debuggerContext = null;

  try {
    await ensureRuntimeMonitor(tabId);
    runtimeContext = await captureRuntimeContext(tabId);
  } catch (error) {
    console.warn('LLM Clip runtime context capture failed; continuing without runtime evidence.', error);
  }

  try {
    debuggerContext = await captureChromeDebuggerContext(tabId, {
      url: pageContext.url,
      title: pageContext.title,
    });
  } catch (error) {
    console.warn('LLM Clip Chrome debugger snapshot failed; continuing without debugger evidence.', error);
  }

  if (runtimeContext) {
    runtimeContext = {
      ...runtimeContext,
      chromeDebugger: debuggerContext,
    };
  } else if (debuggerContext) {
    runtimeContext = {
      summary: {
        installedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        eventCount: 0,
        errorCount: 0,
        warningCount: 0,
        networkRequestCount: 0,
        failedRequestCount: 0,
        slowRequestCount: 0,
        hasDomSummary: true,
      },
      events: [],
      network: [],
      domSummary: {
        path: `${new URL(pageContext.url).pathname}${new URL(pageContext.url).search}${new URL(pageContext.url).hash}`,
        headingTexts: pageContext.domSummary.headings,
        buttonTexts: pageContext.domSummary.buttons,
        inputLabels: pageContext.domSummary.fields,
      },
      chromeDebugger: debuggerContext,
    };
  }

  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: 'png',
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    func: mountClipOverlay,
    args: [clipMode, screenshotDataUrl, pageContext, runtimeContext, options?.launchMode ?? 'editor', null],
  });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

async function ensureTabOverlayAccess(
  tab: chrome.tabs.Tab & { id: number },
  interactive: boolean,
): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => true,
    });
    return;
  } catch (error) {
    if (!isHostAccessError(error)) {
      throw error;
    }
  }

  const accessResult = await requestTabHostAccess(tab, { interactive });
  const hostLabel = getUrlHostLabel(tab.url);

  if (accessResult === 'granted') {
    return;
  }

  if (accessResult === 'requested') {
    throw new Error(
      `LLM Clip needs access to ${hostLabel} before it can reopen this clip. Chrome should show a site access request in the tab. Approve it, then try again.`,
    );
  }

  throw new Error(
    `LLM Clip needs access to ${hostLabel} before it can reopen this clip. Grant site access and try again.`,
  );
}

export async function openSavedClipEditor(
  clip: ClipRecord,
  options?: {
    tabId?: number;
    interactive?: boolean;
  },
): Promise<void> {
  const tab =
    typeof options?.tabId === 'number' ? await getSupportedTabById(options.tabId) : await getSupportedActiveTab();
  const imageBlob = await getClipAssetBlob(clip.imageAssetId);
  if (!imageBlob) {
    throw new Error('LLM Clip could not load the saved clip image.');
  }

  await ensureTabOverlayAccess(tab, options?.interactive ?? true);

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: cancelMountedClipOverlay,
    });
  } catch {
    // Ignore if there was no mounted overlay or the page was in-between states.
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: mountClipOverlay,
    args: [
      clip.clipMode,
      await blobToDataUrl(imageBlob),
      {
        ...clip.page,
        domSummary: clip.domSummary,
      },
      clip.runtimeContext,
      'saved-editor',
      {
        clipId: clip.id,
        title: clip.title,
        note: clip.note,
        annotations: clip.annotations,
        crop: clip.crop,
      },
    ],
  });
}

export async function cancelClipOverlay(tabId?: number): Promise<void> {
  const tab = typeof tabId === 'number' ? await getSupportedTabById(tabId) : await getSupportedActiveTab();

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: cancelMountedClipOverlay,
  });
}
