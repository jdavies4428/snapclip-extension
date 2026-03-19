import { collectPageContext } from '../content-script';
import type { ClipAnnotation, ClipMode, ClipRect, RuntimeContext } from '../shared/types/session';
import type { PageContext } from '../shared/types/snapshot';
import { pageContextSchema } from '../shared/types/snapshot';
import { ensureSupportedWindow, getSupportedActiveTab, getSupportedTabById } from './permissions';
import { captureRuntimeContext, ensureRuntimeMonitor } from './runtime';
import { commitClipToSession } from './session';

function mountClipOverlay(
  clipMode: ClipMode,
  screenshotDataUrl: string,
  pageContext: PageContext,
  runtimeContext: RuntimeContext | null,
) {
  const overlayId = 'snapclip-overlay-root';

  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);

  const removeOverlay = () => {
    document.getElementById(overlayId)?.remove();
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
        url: 'src/offscreen/index.html',
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

  const copyTextToClipboard = async (text: string) => {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
      type: 'offscreen-copy-text',
      text,
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Clipboard copy failed.');
    }
  };

  const copyImageToClipboard = async (dataUrl: string) => {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
      type: 'offscreen-copy-image',
      dataUrl,
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Image copy failed in this browser context.');
    }
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
  root.style.background = 'rgba(6, 12, 24, 0.1)';

  const veil = document.createElement('div');
  veil.style.position = 'absolute';
  veil.style.inset = '0';
  veil.style.background = 'rgba(6, 12, 24, 0.5)';
  root.append(veil);

  const selection = document.createElement('div');
  selection.style.position = 'fixed';
  selection.style.border = '2px solid #67c9ff';
  selection.style.background = 'rgba(103, 201, 255, 0.18)';
  selection.style.borderRadius = '12px';
  selection.style.pointerEvents = 'none';
  selection.style.display = clipMode === 'visible' ? 'block' : 'none';
  root.append(selection);

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

  const updateSelection = (rect: ClipRect) => {
    activeRect = rect;
    selection.style.display = 'block';
    selection.style.left = `${rect.x}px`;
    selection.style.top = `${rect.y}px`;
    selection.style.width = `${rect.width}px`;
    selection.style.height = `${rect.height}px`;
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
        hint.textContent = 'That area was too small. Drag a larger area or press Esc to cancel.';
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
    window.removeEventListener('keydown', handleEscape, true);
    removeOverlay();
  };

  window.addEventListener('keydown', handleEscape, true);

  const saveClip = async (rect: ClipRect) => {
    if (isSaving) {
      return;
    }

    try {
      isSaving = true;
      hint.textContent = clipMode === 'visible' ? 'Saving visible clip...' : 'Saving clip...';

      const clipDataUrl = await cropImageDataUrl(rect);
      const image = new Image();
      image.src = clipDataUrl;
      await image.decode();

      await chrome.runtime.sendMessage({
        type: 'commit-clip',
        clipMode,
        imageDataUrl: clipDataUrl,
        imageWidth: image.naturalWidth,
        imageHeight: image.naturalHeight,
        crop: rect,
        pageContext,
        runtimeContext,
      });

      await chrome.runtime.sendMessage({
        type: 'open-side-panel',
      });

      window.removeEventListener('keydown', handleEscape, true);
      removeOverlay();
    } catch (error) {
      hint.textContent = error instanceof Error ? error.message : 'Clip save failed. Press Esc to cancel.';
      isSaving = false;
    }
  };

  const openEditor = async (rect: ClipRect) => {
    if (isSaving) {
      return;
    }

    isSaving = true;
    phase = 'editing';
    hint.textContent = 'Preparing your clip...';

    try {
      const clipDataUrl = await cropImageDataUrl(rect);
      const image = new Image();
      image.src = clipDataUrl;
      await image.decode();

      root.replaceChildren(veil);
      root.append(hint);
      hint.textContent = 'Name the clip, annotate if you want, then copy or save it.';

      const editor = document.createElement('div');
      editor.style.position = 'fixed';
      editor.style.left = '50%';
      editor.style.top = '50%';
      editor.style.transform = 'translate(-50%, -50%)';
      editor.style.width = 'min(1320px, calc(100vw - 20px))';
      editor.style.height = 'calc(100vh - 20px)';
      editor.style.maxHeight = 'calc(100vh - 20px)';
      editor.style.overflow = 'hidden';
      editor.style.boxSizing = 'border-box';
      editor.style.padding = '24px';
      editor.style.borderRadius = '24px';
      editor.style.background = 'rgba(8, 15, 28, 0.98)';
      editor.style.border = '1px solid rgba(115, 187, 255, 0.24)';
      editor.style.boxShadow = '0 22px 80px rgba(0, 0, 0, 0.45)';
      editor.style.color = '#e7edf7';
      editor.style.fontFamily = '"SF Pro Display", "Segoe UI", sans-serif';
      editor.style.zIndex = '2147483647';
      editor.style.display = 'grid';
      editor.style.gap = '16px';
      editor.style.gridTemplateRows = 'auto minmax(0, 1fr)';
      editor.style.scrollbarWidth = 'none';

      const titleRow = document.createElement('div');
      titleRow.style.display = 'grid';
      titleRow.style.gap = '8px';

      const titleTopRow = document.createElement('div');
      titleTopRow.style.display = 'flex';
      titleTopRow.style.alignItems = 'center';
      titleTopRow.style.justifyContent = 'space-between';
      titleTopRow.style.gap = '12px';

      const titleEyebrow = document.createElement('p');
      titleEyebrow.textContent = 'LLM CLIP';
      titleEyebrow.style.margin = '0';
      titleEyebrow.style.fontSize = '12px';
      titleEyebrow.style.fontWeight = '700';
      titleEyebrow.style.letterSpacing = '0.12em';
      titleEyebrow.style.color = '#82c6ff';

      const closeButton = document.createElement('button');
      closeButton.textContent = 'X';
      closeButton.setAttribute('aria-label', 'Close clip editor');
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

      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.value = await getNextClipTitle();
      titleInput.placeholder = 'Clip name';
      titleInput.style.border = '1px solid rgba(103, 209, 255, 0.24)';
      titleInput.style.borderRadius = '16px';
      titleInput.style.padding = '14px 16px';
      titleInput.style.background = 'rgba(255,255,255,0.05)';
      titleInput.style.color = '#eef4fb';
      titleInput.style.font = 'inherit';
      titleInput.style.fontSize = '26px';
      titleInput.style.fontWeight = '700';

      const titleSub = document.createElement('p');
      titleSub.textContent = pageContext.title || 'Captured clip';
      titleSub.style.margin = '0';
      titleSub.style.fontSize = '14px';
      titleSub.style.lineHeight = '1.5';
      titleSub.style.color = '#b7c4da';

      titleTopRow.append(titleEyebrow, closeButton);
      titleRow.append(titleTopRow, titleInput, titleSub);

      const actionRow = document.createElement('div');
      actionRow.style.display = 'grid';
      actionRow.style.gap = '10px';

      const toolRow = document.createElement('div');
      toolRow.style.display = 'grid';
      toolRow.style.gridTemplateColumns = 'repeat(4, minmax(0, 1fr))';
      toolRow.style.gap = '8px';

      const toolTextButton = document.createElement('button');
      toolTextButton.textContent = 'Text';
      const toolBoxButton = document.createElement('button');
      toolBoxButton.textContent = 'Box';
      const toolArrowButton = document.createElement('button');
      toolArrowButton.textContent = 'Arrow';
      const toolUndoButton = document.createElement('button');
      toolUndoButton.textContent = 'Undo';

      const removeButton = document.createElement('button');
      removeButton.textContent = 'Remove last box';
      const copyButton = document.createElement('button');
      copyButton.textContent = 'Copy image';
      const copySummaryButton = document.createElement('button');
      copySummaryButton.textContent = 'Copy packet summary';
      const saveButton = document.createElement('button');
      saveButton.textContent = 'Save clip';
      const cancelButton = document.createElement('button');
      cancelButton.textContent = 'Cancel';

      [toolBoxButton, toolTextButton, toolArrowButton, toolUndoButton, removeButton, copyButton, copySummaryButton, saveButton, cancelButton].forEach((button, index) => {
        button.style.border = '0';
        button.style.borderRadius = '12px';
        button.style.padding = '11px 14px';
        button.style.font = 'inherit';
        button.style.fontWeight = '700';
        button.style.cursor = 'pointer';
        button.style.background =
          button === saveButton
            ? 'linear-gradient(135deg, #6acfff 0%, #3b82ff 100%)'
            : 'rgba(255,255,255,0.08)';
        button.style.color = button === saveButton ? '#041220' : '#edf3fb';
        button.style.width = '100%';
      });

      toolUndoButton.title = 'Remove the most recent annotation.';

      const copyRow = document.createElement('div');
      copyRow.style.display = 'grid';
      copyRow.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
      copyRow.style.gap = '8px';

      const saveRow = document.createElement('div');
      saveRow.style.display = 'grid';
      saveRow.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
      saveRow.style.gap = '8px';

      toolRow.append(toolTextButton, toolBoxButton, toolArrowButton, toolUndoButton);
      copyRow.append(copyButton, copySummaryButton);
      saveRow.append(saveButton, cancelButton);
      actionRow.append(toolRow, copyRow, saveRow);

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
      sideRail.style.gridTemplateRows = 'auto minmax(0, 1fr)';
      sideRail.style.gap = '12px';
      sideRail.style.minHeight = '0';
      sideRail.style.overflow = 'hidden';

      const makeCard = (title: string) => {
        const card = document.createElement('section');
        card.style.display = 'grid';
        card.style.gap = '10px';
        card.style.padding = '14px';
        card.style.borderRadius = '18px';
        card.style.border = '1px solid rgba(157, 177, 207, 0.16)';
        card.style.background = 'rgba(255, 255, 255, 0.04)';

        const heading = document.createElement('h3');
        heading.textContent = title;
        heading.style.margin = '0';
        heading.style.fontSize = '15px';

        card.append(heading);
        return card;
      };

      const systemCard = makeCard('System info');
      const runtimeCard = makeCard('Captured context');
      const recentCard = makeCard('Recent issues');

      const railScroll = document.createElement('div');
      railScroll.style.display = 'grid';
      railScroll.style.gap = '12px';
      railScroll.style.minHeight = '0';
      railScroll.style.overflowY = 'auto';
      railScroll.style.paddingRight = '2px';
      railScroll.style.scrollbarWidth = 'none';

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
      systemCard.append(systemList);

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

      runtimeCard.append(runtimeCopy);

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

      recentCard.append(recentList);

      mainColumn.append(metaRow, stage);
      railScroll.append(systemCard, runtimeCard, recentCard);
      sideRail.append(actionRow, railScroll);
      contentGrid.append(mainColumn, sideRail);
      editor.append(titleRow, contentGrid);
      root.append(editor);

      const shortcutToast = document.createElement('div');
      shortcutToast.textContent = 'Shortcuts: Area Option/Alt + Shift + S. Visible Option/Alt + Shift + D.';
      shortcutToast.style.position = 'fixed';
      shortcutToast.style.top = '18px';
      shortcutToast.style.right = '18px';
      shortcutToast.style.padding = '10px 12px';
      shortcutToast.style.borderRadius = '12px';
      shortcutToast.style.background = 'rgba(8, 15, 28, 0.92)';
      shortcutToast.style.border = '1px solid rgba(115, 187, 255, 0.28)';
      shortcutToast.style.color = '#dbe7f7';
      shortcutToast.style.fontSize = '12px';
      shortcutToast.style.fontWeight = '600';
      shortcutToast.style.zIndex = '2147483647';
      shortcutToast.style.pointerEvents = 'none';
      root.append(shortcutToast);

      window.setTimeout(() => {
        shortcutToast.remove();
      }, 2200);

      window.setTimeout(() => {
        titleInput.focus();
        const length = titleInput.value.length;
        titleInput.setSelectionRange(length, length);
      }, 30);

      let activeTool: 'text' | 'box' | 'arrow' = 'box';
      let editorStartPoint: { x: number; y: number } | null = null;
      let editorDraftShape:
        | { kind: 'box'; x: number; y: number; width: number; height: number }
        | { kind: 'arrow'; startX: number; startY: number; endX: number; endY: number }
        | null = null;
      let annotations: ClipAnnotation[] = [];

      const annotationColor = '#ff8a5b';

      const renderEditorAnnotations = () => {
        stage.querySelectorAll('[data-snapclip-annotation]').forEach((node) => node.remove());

        const drawBox = (
          annotation: { x: number; y: number; width: number; height: number },
          draft = false,
        ) => {
          const node = document.createElement('div');
          node.dataset.snapclipAnnotation = 'true';
          node.style.position = 'absolute';
          node.style.left = `${annotation.x}%`;
          node.style.top = `${annotation.y}%`;
          node.style.width = `${annotation.width}%`;
          node.style.height = `${annotation.height}%`;
          node.style.border = `3px ${draft ? 'dashed' : 'solid'} ${annotationColor}`;
          node.style.borderRadius = '12px';
          node.style.background = 'rgba(255, 138, 91, 0.14)';
          node.style.pointerEvents = 'none';
          stage.append(node);
        };

        const drawArrow = (
          annotation: { startX: number; startY: number; endX: number; endY: number },
          draft = false,
        ) => {
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
          line.setAttribute('stroke-width', '0.7');
          line.setAttribute('stroke-linecap', 'round');
          if (draft) {
            line.setAttribute('stroke-dasharray', '2 1.5');
          } else {
            line.setAttribute('marker-end', `url(#${markerId})`);
            svg.append(defs);
          }

          svg.append(line);
          stage.append(svg);
        };

        const drawText = (annotation: { x: number; y: number; text: string }) => {
          const node = document.createElement('div');
          node.dataset.snapclipAnnotation = 'true';
          node.textContent = annotation.text;
          node.style.position = 'absolute';
          node.style.left = `${annotation.x}%`;
          node.style.top = `${annotation.y}%`;
          node.style.transform = 'translateY(-100%)';
          node.style.padding = '6px 10px';
          node.style.borderRadius = '10px';
          node.style.background = 'rgba(8, 15, 28, 0.88)';
          node.style.border = `2px solid ${annotationColor}`;
          node.style.color = '#eef4fb';
          node.style.fontSize = '14px';
          node.style.fontWeight = '700';
          node.style.lineHeight = '1.35';
          node.style.pointerEvents = 'none';
          node.style.maxWidth = '58%';
          node.style.wordBreak = 'break-word';
          stage.append(node);
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
        annotations = annotations.slice(0, -1);
        renderEditorAnnotations();
      };

      removeButton.addEventListener('click', removeLastAnnotation);
      toolUndoButton.addEventListener('click', removeLastAnnotation);

      copyButton.addEventListener('click', () => {
        void copyImageToClipboard(clipDataUrl)
          .then(() => {
            hint.textContent = 'Clip image copied. You can keep annotating or save.';
          })
          .catch((error) => {
            hint.textContent = error instanceof Error ? error.message : 'Image copy failed.';
          });
      });

      copySummaryButton.addEventListener('click', () => {
        const issueLines = recentMessages.length
          ? recentMessages.map((line) => `- ${line}`).join('\n')
          : '- No immediate errors or failed requests captured.';
        const summaryText = [
          `# ${titleInput.value || 'Clip'}`,
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

        void copyTextToClipboard(summaryText)
          .then(() => {
            hint.textContent = 'Packet summary copied. You can paste it directly into Claude or another chat.';
          })
          .catch((error) => {
            hint.textContent = error instanceof Error ? error.message : 'Summary copy failed.';
          });
      });

      closeButton.addEventListener('click', () => {
        window.removeEventListener('keydown', handleEscape, true);
        removeOverlay();
      });

      cancelButton.addEventListener('click', () => {
        window.removeEventListener('keydown', handleEscape, true);
        removeOverlay();
      });

      const syncActiveTool = () => {
        toolTextButton.style.boxShadow = activeTool === 'text' ? '0 0 0 1px rgba(103, 209, 255, 0.5) inset' : 'none';
        toolBoxButton.style.boxShadow = activeTool === 'box' ? '0 0 0 1px rgba(103, 209, 255, 0.5) inset' : 'none';
        toolArrowButton.style.boxShadow = activeTool === 'arrow' ? '0 0 0 1px rgba(103, 209, 255, 0.5) inset' : 'none';
      };

      toolTextButton.addEventListener('click', () => {
        activeTool = 'text';
        syncActiveTool();
      });

      toolBoxButton.addEventListener('click', () => {
        activeTool = 'box';
        syncActiveTool();
      });

      toolArrowButton.addEventListener('click', () => {
        activeTool = 'arrow';
        syncActiveTool();
      });

      syncActiveTool();

      stage.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        stage.setPointerCapture(event.pointerId);
        const bounds = stage.getBoundingClientRect();
        editorStartPoint = {
          x: clamp(event.clientX - bounds.left, 0, bounds.width),
          y: clamp(event.clientY - bounds.top, 0, bounds.height),
        };

        if (activeTool === 'text') {
          const point = toPercentPoint(event.clientX, event.clientY, bounds);
          editorStartPoint = null;
          const text = window.prompt('Text annotation');
          if (!text?.trim()) {
            return;
          }

          annotations = [
            ...annotations,
            {
              id: `annotation_${Date.now()}`,
              kind: 'text',
              color: annotationColor,
              text: text.trim(),
              x: point.x,
              y: point.y,
            },
          ];
          renderEditorAnnotations();
        }
      });

      stage.addEventListener('pointermove', (event) => {
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
            annotations = [
              ...annotations,
              {
                id: `annotation_${Date.now()}`,
                kind: 'box',
                color: annotationColor,
                ...nextRect,
              },
            ];
          }
        } else if (activeTool === 'arrow') {
          const point = toPercentPoint(event.clientX, event.clientY, bounds);
          const startX = (startPoint.x / bounds.width) * 100;
          const startY = (startPoint.y / bounds.height) * 100;
          const distance = Math.hypot(point.x - startX, point.y - startY);
          if (distance >= 1.2) {
            annotations = [
              ...annotations,
              {
                id: `annotation_${Date.now()}`,
                kind: 'arrow',
                color: annotationColor,
                startX,
                startY,
                endX: point.x,
                endY: point.y,
              },
            ];
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
            await chrome.runtime.sendMessage({
              type: 'commit-clip',
              clipMode,
              title: titleInput.value,
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

            window.removeEventListener('keydown', handleEscape, true);
            removeOverlay();
          } catch (error) {
            hint.textContent = error instanceof Error ? error.message : 'Clip save failed.';
            saveButton.disabled = false;
            saveButton.textContent = 'Save clip';
          }
        })();
      });

      isSaving = false;
    } catch (error) {
      hint.textContent = error instanceof Error ? error.message : 'Clip preparation failed.';
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

  if (clipMode === 'visible') {
    await commitClipToSession({
      clipMode,
      imageDataUrl: screenshotDataUrl,
      imageWidth: Math.round(pageContext.viewport.width * pageContext.viewport.dpr),
      imageHeight: Math.round(pageContext.viewport.height * pageContext.viewport.dpr),
      crop: {
        x: 0,
        y: 0,
        width: pageContext.viewport.width,
        height: pageContext.viewport.height,
      },
      pageContext,
      runtimeContext,
    });
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    func: mountClipOverlay,
    args: [clipMode, screenshotDataUrl, pageContext, runtimeContext],
  });
}
