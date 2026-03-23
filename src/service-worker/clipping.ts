import { collectPageContext } from '../content-script';
import type { ClipAnnotation, ClipMode, ClipRect, RuntimeContext } from '../shared/types/session';
import type { PageContext } from '../shared/types/snapshot';
import { pageContextSchema } from '../shared/types/snapshot';
import { ensureSupportedWindow, getSupportedActiveTab, getSupportedTabById } from './permissions';
import { captureRuntimeContext, ensureRuntimeMonitor } from './runtime';

function mountClipOverlay(
  clipMode: ClipMode,
  screenshotDataUrl: string,
  pageContext: PageContext,
  runtimeContext: RuntimeContext | null,
) {
  const overlayId = 'snapclip-overlay-root';
  const cancelOverlayKey = '__llmClipCancelOverlay';

  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);

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

  const getNextClipTitle = async () => {
    const response = await chrome.runtime.sendMessage({
      type: 'get-clip-session',
    });

    if (response?.ok && response.session) {
      return `Clip ${response.session.clips.length + 1}`;
    }

    return 'Clip 1';
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
  root.style.cursor = clipMode === 'region' ? 'crosshair' : 'default';
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
  selection.style.display = clipMode === 'visible' ? 'block' : 'none';
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
    clipMode === 'visible'
      ? 'Saving the visible tab...'
      : 'Drag to select. Release to capture. Press Esc to cancel.';
  root.append(hint);

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
      if (!dragStart) {
        return;
      }

      updateSelection(
        normalizeRect(
          dragStart.x,
          dragStart.y,
          clamp(event.clientX, 0, window.innerWidth),
          clamp(event.clientY, 0, window.innerHeight),
        ),
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

  const openEditor = async (rect: ClipRect) => {
    if (isSaving) {
      return;
    }

    isSaving = true;
    phase = 'editing';
      announce('Preparing your clip...');

    try {
      const clipDataUrl = await cropImageDataUrl(rect);
      const image = new Image();
      image.src = clipDataUrl;
      await image.decode();

      root.replaceChildren();
      root.append(hint);
      announce('Name the clip, annotate if you want, then copy or save it.');

      const editor = document.createElement('div');
      editor.style.position = 'fixed';
      editor.style.left = '50%';
      editor.style.top = '50%';
      editor.style.transform = 'translate(-50%, -50%)';
      editor.style.width = '85vw';
      editor.style.height = '85vh';
      editor.style.maxWidth = '85vw';
      editor.style.maxHeight = '85vh';
      editor.style.overflow = 'hidden';
      editor.style.boxSizing = 'border-box';
      editor.style.padding = '18px';
      editor.style.borderRadius = '24px';
      editor.style.background = 'rgba(8, 15, 28, 0.98)';
      editor.style.border = '1px solid rgba(115, 187, 255, 0.24)';
      editor.style.boxShadow = '0 22px 80px rgba(0, 0, 0, 0.45)';
      editor.style.color = '#e7edf7';
      editor.style.fontFamily = '"SF Pro Display", "Segoe UI", sans-serif';
      editor.style.zIndex = '2147483647';
      editor.style.display = 'grid';
      editor.style.gap = '0';
      editor.style.gridTemplateRows = 'minmax(0, 1fr)';
      editor.style.scrollbarWidth = 'none';

      const titleEyebrow = document.createElement('p');
      titleEyebrow.textContent = 'LLM CLIP';
      titleEyebrow.style.margin = '0';
      titleEyebrow.style.fontSize = '12px';
      titleEyebrow.style.fontWeight = '700';
      titleEyebrow.style.letterSpacing = '0.12em';
      titleEyebrow.style.color = '#b9e7ff';

      const titleHint = document.createElement('span');
      titleHint.textContent = 'Esc to close';
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
      closeButton.style.position = 'relative';
      closeButton.style.zIndex = '2';

      const railHeader = document.createElement('div');
      railHeader.style.display = 'grid';
      railHeader.style.gap = '10px';
      railHeader.style.padding = '14px';
      railHeader.style.borderRadius = '18px';
      railHeader.style.background =
        'linear-gradient(135deg, rgba(83, 197, 255, 0.22) 0%, rgba(59, 130, 255, 0.16) 100%)';
      railHeader.style.border = '1px solid rgba(117, 204, 255, 0.35)';
      railHeader.style.boxShadow = '0 12px 36px rgba(35, 116, 255, 0.18)';

      const titleTopRow = document.createElement('div');
      titleTopRow.style.display = 'flex';
      titleTopRow.style.alignItems = 'center';
      titleTopRow.style.justifyContent = 'space-between';
      titleTopRow.style.gap = '12px';

      const titleControls = document.createElement('div');
      titleControls.style.display = 'flex';
      titleControls.style.alignItems = 'center';
      titleControls.style.gap = '10px';

      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.value = await getNextClipTitle();
      titleInput.placeholder = 'Clip name';
      titleInput.style.border = '1px solid rgba(103, 209, 255, 0.24)';
      titleInput.style.borderRadius = '14px';
      titleInput.style.padding = '12px 14px';
      titleInput.style.background = 'rgba(255,255,255,0.05)';
      titleInput.style.color = '#eef4fb';
      titleInput.style.font = 'inherit';
      titleInput.style.fontSize = '20px';
      titleInput.style.fontWeight = '700';

      const titleSub = document.createElement('p');
      titleSub.textContent = pageContext.title || 'Captured clip';
      titleSub.style.margin = '0';
      titleSub.style.fontSize = '13px';
      titleSub.style.lineHeight = '1.5';
      titleSub.style.color = '#b7c4da';

      titleControls.append(titleHint, closeButton);
      titleTopRow.append(titleEyebrow, titleControls);
      railHeader.append(titleTopRow, titleInput, titleSub);

      const noteCard = document.createElement('div');
      noteCard.style.display = 'grid';
      noteCard.style.gap = '8px';
      noteCard.style.padding = '14px';
      noteCard.style.borderRadius = '18px';
      noteCard.style.border = '1px solid rgba(157, 177, 207, 0.16)';
      noteCard.style.background = 'rgba(255, 255, 255, 0.05)';
      noteCard.style.minHeight = '0';
      noteCard.style.overflow = 'hidden';

      const noteLabel = document.createElement('div');
      noteLabel.textContent = 'Prompt for the LLM';
      noteLabel.style.color = '#88d5ff';
      noteLabel.style.fontSize = '12px';
      noteLabel.style.fontWeight = '700';
      noteLabel.style.letterSpacing = '0.08em';
      noteLabel.style.textTransform = 'uppercase';

      const noteHelp = document.createElement('p');
      noteHelp.textContent = 'Describe the task, what looks wrong, and what you want investigated.';
      noteHelp.style.margin = '0';
      noteHelp.style.color = '#b7c4da';
      noteHelp.style.fontSize = '13px';
      noteHelp.style.lineHeight = '1.45';

      const noteField = document.createElement('textarea');
      noteField.placeholder = 'Enter prompt for the LLM...';
      noteField.style.width = '100%';
      noteField.style.minHeight = '112px';
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
      noteCard.append(noteLabel, noteHelp, noteField);

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
      toolRow.style.gridTemplateColumns = 'repeat(5, minmax(0, 1fr))';
      toolRow.style.gap = '8px';

      const toolSelectButton = document.createElement('button');
      toolSelectButton.textContent = 'Select';
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
      copySummaryButton.textContent = 'Copy summary';
      const saveButton = document.createElement('button');
      saveButton.textContent = 'Save clip';
      const cancelButton = document.createElement('button');
      cancelButton.textContent = 'Cancel';
      const detailsButton = document.createElement('button');
      detailsButton.textContent = 'System info';

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

      [toolSelectButton, toolBoxButton, toolTextButton, toolArrowButton, toolUndoButton, copyButton, copyInstructionsButton, copySummaryButton, saveButton, cancelButton, detailsButton].forEach((button) => {
        button.style.border = '0';
        button.style.borderRadius = '12px';
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
      copySummaryButton.title = 'Copy the full text packet with prompt and context.';

      const hoverButtons: Array<[HTMLButtonElement, string]> = [
        [toolSelectButton, 'Select and edit existing annotations.'],
        [copyButton, 'Copy the clipped screenshot only.'],
        [copyInstructionsButton, 'Copy just your LLM prompt from this clip.'],
        [copySummaryButton, 'Copy the full packet text: prompt, page info, and recent issues.'],
        [saveButton, 'Save this clip to the session gallery.'],
        [cancelButton, 'Close this clip without saving it.'],
        [detailsButton, 'Open the system info and captured context screen for this clip.'],
      ];

      hoverButtons.forEach(([button, text]) => {
        button.addEventListener('mouseenter', () => showHoverCard(button, text));
        button.addEventListener('mouseleave', hideHoverCard);
        button.addEventListener('focus', () => showHoverCard(button, text));
        button.addEventListener('blur', hideHoverCard);
      });

      const copyRow = document.createElement('div');
      copyRow.style.display = 'grid';
      copyRow.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
      copyRow.style.gap = '8px';

      const saveRow = document.createElement('div');
      saveRow.style.display = 'grid';
      saveRow.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
      saveRow.style.gap = '8px';

      const utilityRow = document.createElement('div');
      utilityRow.style.display = 'grid';
      utilityRow.style.gridTemplateColumns = 'minmax(0, 1fr)';
      utilityRow.style.gap = '8px';

      toolRow.append(toolSelectButton, toolTextButton, toolBoxButton, toolArrowButton, toolUndoButton);
      copyRow.append(copyButton, copyInstructionsButton, copySummaryButton);
      saveRow.append(saveButton, cancelButton);
      utilityRow.append(detailsButton);
      actionRow.append(copyRow, saveRow, utilityRow, actionStatus, toolRow);

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
      contentGrid.style.gridTemplateColumns = 'minmax(0, 1fr) 320px';
      contentGrid.style.gap = '18px';
      contentGrid.style.minHeight = '0';
      contentGrid.style.height = '100%';

      const mainColumn = document.createElement('div');
      mainColumn.style.display = 'grid';
      mainColumn.style.gridTemplateRows = 'auto minmax(0, 1fr)';
      mainColumn.style.gap = '14px';
      mainColumn.style.minHeight = '0';

      const sideRail = document.createElement('aside');
      sideRail.style.display = 'grid';
      sideRail.style.gridTemplateRows = 'auto auto auto minmax(0, 1fr)';
      sideRail.style.gap = '12px';
      sideRail.style.minHeight = '0';
      sideRail.style.overflow = 'hidden';

      const makeCard = (title: string, preview: string, open = false) => {
        const card = document.createElement('details');
        card.open = open;
        card.style.display = 'grid';
        card.style.gap = '10px';
        card.style.padding = '14px';
        card.style.borderRadius = '18px';
        card.style.border = '1px solid rgba(157, 177, 207, 0.16)';
        card.style.background = 'rgba(255, 255, 255, 0.04)';

        const summary = document.createElement('summary');
        summary.style.display = 'grid';
        summary.style.gap = '4px';
        summary.style.cursor = 'pointer';
        summary.style.listStyle = 'none';
        summary.style.outline = 'none';

        const heading = document.createElement('h3');
        heading.textContent = title;
        heading.style.margin = '0';
        heading.style.fontSize = '15px';

        const blurb = document.createElement('p');
        blurb.textContent = preview;
        blurb.style.margin = '0';
        blurb.style.color = '#9db2cf';
        blurb.style.fontSize = '12px';
        blurb.style.lineHeight = '1.45';

        const body = document.createElement('div');
        body.style.display = 'grid';
        body.style.gap = '10px';
        body.style.marginTop = '10px';

        summary.append(heading, blurb);
        card.append(summary, body);
        return { card, body };
      };

      const railScroll = document.createElement('div');
      railScroll.style.display = 'grid';
      railScroll.style.gap = '12px';
      railScroll.style.minHeight = '0';
      railScroll.style.overflowY = 'auto';
      railScroll.style.paddingRight = '2px';
      railScroll.style.scrollbarWidth = 'none';
      railScroll.style.setProperty('-ms-overflow-style', 'none');

      const composePanel = document.createElement('div');
      composePanel.style.display = 'grid';
      composePanel.style.gridTemplateRows = 'auto auto minmax(0, 1fr)';
      composePanel.style.gap = '12px';
      composePanel.style.minHeight = '0';

      const detailsPanel = document.createElement('div');
      detailsPanel.style.display = 'none';
      detailsPanel.style.gridTemplateRows = 'auto minmax(0, 1fr)';
      detailsPanel.style.gap = '12px';
      detailsPanel.style.minHeight = '0';

      const detailsHead = document.createElement('div');
      detailsHead.style.display = 'flex';
      detailsHead.style.alignItems = 'center';
      detailsHead.style.justifyContent = 'space-between';
      detailsHead.style.gap = '10px';
      detailsHead.style.padding = '6px 2px 0';

      const detailsTitleBlock = document.createElement('div');
      detailsTitleBlock.style.display = 'grid';
      detailsTitleBlock.style.gap = '4px';

      const detailsEyebrow = document.createElement('div');
      detailsEyebrow.textContent = 'DETAILS';
      detailsEyebrow.style.color = '#88d5ff';
      detailsEyebrow.style.fontSize = '11px';
      detailsEyebrow.style.fontWeight = '700';
      detailsEyebrow.style.letterSpacing = '0.08em';
      detailsEyebrow.style.textTransform = 'uppercase';

      const detailsTitle = document.createElement('h3');
      detailsTitle.textContent = 'Clip context';
      detailsTitle.style.margin = '0';
      detailsTitle.style.fontSize = '16px';
      detailsTitle.style.color = '#eef4fb';

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

      detailsTitleBlock.append(detailsEyebrow, detailsTitle);
      detailsHead.append(detailsTitleBlock, detailsBackButton);

      const stage = document.createElement('div');
      stage.style.position = 'relative';
      stage.style.borderRadius = '18px';
      stage.style.overflow = 'hidden';
      stage.style.border = '1px solid rgba(157, 177, 207, 0.16)';
      stage.style.background = '#050811';
      stage.style.cursor = 'crosshair';
      stage.style.minHeight = '0';
      stage.style.touchAction = 'none';
      stage.style.userSelect = 'none';
      stage.tabIndex = 0;

      const stageImage = document.createElement('img');
      stageImage.src = clipDataUrl;
      stageImage.alt = titleInput.value;
      stageImage.style.display = 'block';
      stageImage.style.width = '100%';
      stageImage.style.height = '100%';
      stageImage.style.maxHeight = '100%';
      stageImage.style.objectFit = 'contain';
      stageImage.style.userSelect = 'none';
      stageImage.draggable = false;

      stage.append(stageImage);

      const systemList = document.createElement('div');
      systemList.style.display = 'grid';
      systemList.style.gap = '8px';

      const addSystemRow = (label: string, value: string) => {
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
        systemList.append(row);
      };

      addSystemRow('Page', pageContext.title || 'Untitled page');
      addSystemRow('URL', pageContext.url);
      addSystemRow(
        'Viewport',
        `${pageContext.viewport.width} x ${pageContext.viewport.height} @ ${pageContext.viewport.dpr}x`,
      );
      addSystemRow('Platform', `${pageContext.platform} • ${pageContext.language} • ${pageContext.timeZone}`);
      addSystemRow('Clip area', `${Math.round(rect.width)} x ${Math.round(rect.height)} at ${Math.round(rect.x)}, ${Math.round(rect.y)}`);

      const runtimeCopy = document.createElement('div');
      runtimeCopy.style.display = 'grid';
      runtimeCopy.style.gap = '8px';

      const runtimeSummary = runtimeContext?.summary;
      const summaryLines = [
        runtimeSummary ? `${runtimeSummary.eventCount} runtime events seen` : 'No runtime monitor data',
        runtimeSummary ? `${runtimeSummary.errorCount} errors, ${runtimeSummary.warningCount} warnings` : 'No errors or warnings captured',
        runtimeSummary
          ? `${runtimeSummary.failedRequestCount} failed requests, ${runtimeSummary.slowRequestCount} slow requests`
          : 'No network diagnostics captured',
      ];

      summaryLines.forEach((line) => {
        const item = document.createElement('div');
        item.textContent = line;
        item.style.color = '#d8e3f2';
        item.style.fontSize = '13px';
        item.style.lineHeight = '1.45';
        runtimeCopy.append(item);
      });

      if (pageContext.domSummary.selectedText) {
        const selectedText = document.createElement('div');
        selectedText.textContent = `Selected text: ${pageContext.domSummary.selectedText}`;
        selectedText.style.color = '#b9c9e2';
        selectedText.style.fontSize = '12px';
        selectedText.style.lineHeight = '1.5';
        runtimeCopy.append(selectedText);
      }

      const recentList = document.createElement('div');
      recentList.style.display = 'grid';
      recentList.style.gap = '8px';

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

      if (recentMessages.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = 'No immediate errors, warnings, or failed requests were captured.';
        empty.style.color = '#b9c9e2';
        empty.style.fontSize = '13px';
        empty.style.lineHeight = '1.45';
        recentList.append(empty);
      } else {
        recentMessages.forEach((message) => {
          const item = document.createElement('div');
          item.textContent = message;
          item.style.padding = '10px 12px';
          item.style.borderRadius = '12px';
          item.style.background = 'rgba(255, 255, 255, 0.05)';
          item.style.color = '#d8e3f2';
          item.style.fontSize = '12px';
          item.style.lineHeight = '1.45';
          item.style.wordBreak = 'break-word';
          recentList.append(item);
        });
      }

      const systemCard = makeCard(
        'System info',
        `${pageContext.title || 'Untitled page'} • ${Math.round(rect.width)} x ${Math.round(rect.height)}`,
      );
      systemCard.body.append(systemList);

      const runtimePreview = runtimeSummary
        ? `${runtimeSummary.errorCount} errors, ${runtimeSummary.warningCount} warnings, ${runtimeSummary.failedRequestCount} failed requests`
        : 'No monitor data captured';
      const runtimeCard = makeCard('Captured context', runtimePreview);
      runtimeCard.body.append(runtimeCopy);

      const recentCard = makeCard(
        'Recent issues',
        recentMessages.length ? recentMessages[0] : 'No immediate errors or failed requests captured.',
        recentMessages.length > 0,
      );
      recentCard.body.append(recentList);

      mainColumn.append(metaRow, stage);
      railScroll.append(systemCard.card, runtimeCard.card, recentCard.card);
      composePanel.append(noteCard, actionRow);
      detailsPanel.append(detailsHead, railScroll);
      sideRail.append(railHeader, composePanel, detailsPanel);
      contentGrid.append(mainColumn, sideRail);
      editor.append(contentGrid);
      root.append(editor);

      window.setTimeout(() => {
        titleInput.focus();
        const length = titleInput.value.length;
        titleInput.setSelectionRange(length, length);
      }, 30);

      let activeTool: 'select' | 'text' | 'box' | 'arrow' = 'select';
      let railMode: 'compose' | 'details' = 'compose';
      let editorStartPoint: { x: number; y: number } | null = null;
      let editorDraftShape:
        | { kind: 'box'; x: number; y: number; width: number; height: number }
        | { kind: 'arrow'; startX: number; startY: number; endX: number; endY: number }
        | null = null;
      let annotations: ClipAnnotation[] = [];
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
      };

      const closeTextComposer = (restoreFocus = true) => {
        pendingTextPoint = null;
        editingTextAnnotationId = null;
        textComposerInput.value = '';
        textComposer.style.display = 'none';
        composerDragOffset = null;
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
        activeTool = 'select';
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

      toolUndoButton.addEventListener('click', removeLastAnnotation);

      const syncRailMode = () => {
        const showDetails = railMode === 'details';
        composePanel.style.display = showDetails ? 'none' : 'grid';
        detailsPanel.style.display = showDetails ? 'grid' : 'none';
        detailsButton.textContent = showDetails ? 'Back to edit' : 'System info';
      };

      detailsButton.addEventListener('click', () => {
        railMode = 'details';
        syncRailMode();
        setActionStatus('Showing clip details.');
      });

      detailsBackButton.addEventListener('click', () => {
        railMode = 'compose';
        syncRailMode();
        setActionStatus('Back to editing.');
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
          `# ${titleInput.value || 'Clip'}`,
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
          pageContext.domSummary.selectedText ? `Selected text: ${pageContext.domSummary.selectedText}` : '',
          '',
          'Recent issues:',
          issueLines,
        ]
          .filter(Boolean)
          .join('\n');

        void flashButtonState(copySummaryButton, 'Copy summary', 'Copying...', () =>
          copyTextToClipboard(summaryText)
        )
          .then(() => {
            announce('Packet summary copied to your clipboard.', 'success');
            setActionStatus('Packet summary copied.', 'success');
          })
          .catch((error) => {
            setActionStatus('Packet summary copy failed.', 'error');
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
        toolSelectButton.style.boxShadow = activeTool === 'select' ? '0 0 0 1px rgba(103, 209, 255, 0.5) inset' : 'none';
        toolTextButton.style.boxShadow = activeTool === 'text' ? '0 0 0 1px rgba(103, 209, 255, 0.5) inset' : 'none';
        toolBoxButton.style.boxShadow = activeTool === 'box' ? '0 0 0 1px rgba(103, 209, 255, 0.5) inset' : 'none';
        toolArrowButton.style.boxShadow = activeTool === 'arrow' ? '0 0 0 1px rgba(103, 209, 255, 0.5) inset' : 'none';
        stage.style.cursor =
          activeTool === 'text' ? 'text' : activeTool === 'select' ? 'default' : 'crosshair';
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

      toolSelectButton.addEventListener('click', () => {
        activeTool = 'select';
        syncActiveTool();
        setActionStatus('Select tool selected.');
      });

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

      syncActiveTool();
      syncRailMode();

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

        if (activeTool === 'select') {
          selectedAnnotationId = null;
          renderEditorAnnotations();
          setActionStatus('Select an annotation or choose a tool to add one.');
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
            activeTool = 'select';
            syncActiveTool();
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
            activeTool = 'select';
            syncActiveTool();
          }
        }

        renderEditorAnnotations();
      };

      stage.addEventListener('pointerup', finishAnnotation);
      stage.addEventListener('pointercancel', finishAnnotation);

      saveButton.addEventListener('click', () => {
        void (async () => {
          try {
            saveButton.disabled = true;
            saveButton.textContent = 'Saving...';
            setActionStatus('Saving clip...');
            await chrome.runtime.sendMessage({
              type: 'commit-clip',
              clipMode,
              title: titleInput.value,
              note: noteField.value,
              imageDataUrl: clipDataUrl,
              imageWidth: image.naturalWidth,
              imageHeight: image.naturalHeight,
              crop: rect,
              pageContext,
              runtimeContext,
              annotations,
            });

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
            saveButton.textContent = 'Save clip';
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

  if (clipMode === 'visible') {
    void openEditor({
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    });
  }

  document.documentElement.append(root);
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

  const [injectionResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectPageContext,
  });

  const pageContext = pageContextSchema.parse(injectionResult.result);
  let runtimeContext: RuntimeContext | null = null;

  try {
    await ensureRuntimeMonitor(tabId);
    runtimeContext = await captureRuntimeContext(tabId);
  } catch (error) {
    console.warn('LLM Clip runtime context capture failed; continuing without runtime evidence.', error);
  }

  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: 'png',
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    func: mountClipOverlay,
    args: [clipMode, screenshotDataUrl, pageContext, runtimeContext],
  });
}

export async function cancelClipOverlay(tabId?: number): Promise<void> {
  const tab = typeof tabId === 'number' ? await getSupportedTabById(tabId) : await getSupportedActiveTab();

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: cancelMountedClipOverlay,
  });
}
