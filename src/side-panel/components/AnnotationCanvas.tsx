import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ClipAnnotation, ClipRecord } from '../../shared/types/session';

type AnnotationCanvasProps = {
  clip: ClipRecord;
  imageUrl: string | null;
  onChange: (annotations: ClipAnnotation[]) => void;
};

type DrawingTool = 'box' | 'arrow' | 'text' | 'crop';

type DraftShape =
  | {
      kind: 'box';
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | {
      kind: 'arrow';
      startX: number;
      startY: number;
      endX: number;
      endY: number;
    }
  | {
      kind: 'crop';
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | null;

type AnnotationInteractionMode = 'move' | 'resize-box' | 'resize-arrow-start' | 'resize-arrow-end';

type AnnotationInteractionState = {
  id: string;
  mode: AnnotationInteractionMode;
  startPoint: { x: number; y: number };
  original: ClipAnnotation;
};

type TextComposerState = {
  x: number;
  y: number;
  left: number;
  top: number;
  text: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getTextAnnotationSize(text: string) {
  const normalized = text.trim() || ' ';
  const approxCharsPerLine = 18;
  const lines = Math.max(1, Math.ceil(normalized.length / approxCharsPerLine));
  const width = clamp(
    lines === 1 ? normalized.length * 1.45 + 7 : approxCharsPerLine * 1.3 + 7,
    18,
    42,
  );
  const height = clamp(5 + lines * 5.4, 10, 28);

  return { height, width };
}

const toolButtonBase: React.CSSProperties = {
  fontFamily: 'Geist Sans, sans-serif',
  fontSize: '11px',
  fontWeight: 500,
  padding: '4px 8px',
  borderRadius: '5px',
  border: '1px solid transparent',
  background: 'transparent',
  color: '#111110',
  cursor: 'pointer',
  lineHeight: 1.4,
  transition: 'background 80ms, border-color 80ms, box-shadow 80ms',
};

const toolButtonActiveStyle: React.CSSProperties = {
  background: '#FDFCFB',
  borderColor: '#E4DED8',
  boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
};

const toolButtonHoverStyle: React.CSSProperties = {
  background: '#EEE9E3',
};

function ToolButton({
  label,
  keyHint,
  isActive,
  disabled = false,
  onClick,
  style,
}: {
  label: string;
  keyHint?: string;
  isActive?: boolean;
  disabled?: boolean;
  onClick: () => void;
  style?: React.CSSProperties;
}) {
  const [hovered, setHovered] = useState(false);

  const computedStyle: React.CSSProperties = {
    ...toolButtonBase,
    ...(isActive ? toolButtonActiveStyle : hovered ? toolButtonHoverStyle : {}),
    opacity: disabled ? 0.4 : 1,
    cursor: disabled ? 'default' : 'pointer',
    ...style,
  };

  return (
    <button
      aria-label={label}
      aria-pressed={isActive}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={computedStyle}
      type="button"
    >
      {label}
      {keyHint ? (
        <span
          style={{
            fontFamily: 'Geist Mono, monospace',
            fontSize: '9px',
            opacity: 0.5,
            marginLeft: '3px',
          }}
        >
          {keyHint}
        </span>
      ) : null}
    </button>
  );
}

function distanceToSegment(
  pointX: number,
  pointY: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): number {
  const dx = endX - startX;
  const dy = endY - startY;
  if (dx === 0 && dy === 0) {
    return Math.hypot(pointX - startX, pointY - startY);
  }

  const t = clamp(((pointX - startX) * dx + (pointY - startY) * dy) / (dx * dx + dy * dy), 0, 1);
  const projectionX = startX + t * dx;
  const projectionY = startY + t * dy;
  return Math.hypot(pointX - projectionX, pointY - projectionY);
}

function translateAnnotation(annotation: ClipAnnotation, deltaX: number, deltaY: number): ClipAnnotation {
  if (annotation.kind === 'box' || annotation.kind === 'crop') {
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
}

function hitTestAnnotation(
  annotations: ClipAnnotation[],
  point: { x: number; y: number },
): { annotation: ClipAnnotation; mode: AnnotationInteractionMode } | null {
  return (
    [...annotations]
      .reverse()
      .map((annotation) => {
        if (annotation.kind === 'box' || annotation.kind === 'crop') {
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
          const { height, width } = getTextAnnotationSize(annotation.text);
          const top = Math.max(0, annotation.y - 8);
          if (
            point.x >= annotation.x &&
            point.x <= Math.min(100, annotation.x + width) &&
            point.y >= top &&
            point.y <= Math.min(100, top + height)
          ) {
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
      .find((result) => result !== null) ?? null
  );
}

export function AnnotationCanvas({ clip, imageUrl, onChange }: AnnotationCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [activeTool, setActiveTool] = useState<DrawingTool>('text');
  const [draftShape, setDraftShape] = useState<DraftShape>(null);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
  const [movingAnnotation, setMovingAnnotation] = useState<AnnotationInteractionState | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(clip.annotations.at(-1)?.id ?? null);
  const [textComposer, setTextComposer] = useState<TextComposerState | null>(null);
  const [composerDragOffset, setComposerDragOffset] = useState<{ x: number; y: number } | null>(null);

  const previewAnnotations = useMemo(() => clip.annotations, [clip.annotations]);
  const selectedAnnotation = useMemo(
    () => clip.annotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null,
    [clip.annotations, selectedAnnotationId],
  );

  useEffect(() => {
    if (!clip.annotations.length) {
      setSelectedAnnotationId(null);
      return;
    }

    if (!selectedAnnotationId || !clip.annotations.some((annotation) => annotation.id === selectedAnnotationId)) {
      setSelectedAnnotationId(clip.annotations.at(-1)?.id ?? null);
    }
  }, [clip.annotations, selectedAnnotationId]);

  function toPercentPoint(clientX: number, clientY: number, rect: DOMRect) {
    return {
      x: (clamp(clientX - rect.left, 0, rect.width) / rect.width) * 100,
      y: (clamp(clientY - rect.top, 0, rect.height) / rect.height) * 100,
    };
  }

  function toPercentRect(startX: number, startY: number, clientX: number, clientY: number, rect: DOMRect) {
    const endX = clamp(clientX - rect.left, 0, rect.width);
    const endY = clamp(clientY - rect.top, 0, rect.height);
    const normalizedX = Math.min(startX, endX);
    const normalizedY = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    return {
      x: (normalizedX / rect.width) * 100,
      y: (normalizedY / rect.height) * 100,
      width: (width / rect.width) * 100,
      height: (height / rect.height) * 100,
    };
  }

  function openTextComposer(clientX: number, clientY: number, rect: DOMRect) {
    const point = toPercentPoint(clientX, clientY, rect);
    const width = Math.min(260, Math.max(220, rect.width * 0.34));
    const left = clamp(clientX - rect.left + 12, 12, Math.max(12, rect.width - width - 12));
    const top = clamp(clientY - rect.top + 12, 12, Math.max(12, rect.height - 160));
    setTextComposer({
      x: point.x,
      y: point.y,
      left,
      top,
      text: '',
    });
  }

  function closeTextComposer() {
    setTextComposer(null);
    setComposerDragOffset(null);
  }

  function saveTextComposer() {
    if (!textComposer?.text.trim()) {
      closeTextComposer();
      return;
    }

    const nextAnnotation: ClipAnnotation = {
      id: `annotation_${Date.now()}`,
      kind: 'text',
      color: '#FFFFFF',
      text: textComposer.text.trim(),
      x: textComposer.x,
      y: textComposer.y,
    };

    onChange([
      ...clip.annotations,
      nextAnnotation,
    ]);
    setSelectedAnnotationId(nextAnnotation.id);
    closeTextComposer();
  }

  function cycleSelectedAnnotation(direction: -1 | 1) {
    if (!clip.annotations.length) {
      setSelectedAnnotationId(null);
      return;
    }

    const currentIndex = clip.annotations.findIndex((annotation) => annotation.id === selectedAnnotationId);
    const fallbackIndex = direction === 1 ? 0 : clip.annotations.length - 1;
    const nextIndex =
      currentIndex === -1
        ? fallbackIndex
        : (currentIndex + direction + clip.annotations.length) % clip.annotations.length;

    setSelectedAnnotationId(clip.annotations[nextIndex]?.id ?? null);
  }

  function updateSelectedAnnotation(mutate: (annotation: ClipAnnotation) => ClipAnnotation) {
    if (!selectedAnnotationId) {
      return;
    }

    onChange(
      clip.annotations.map((annotation) =>
        annotation.id === selectedAnnotationId ? mutate(annotation) : annotation,
      ),
    );
  }

  function nudgeSelectedAnnotation(deltaX: number, deltaY: number, resize = false) {
    updateSelectedAnnotation((annotation) => {
      if (!resize) {
        return translateAnnotation(annotation, deltaX, deltaY);
      }

      if (annotation.kind === 'box' || annotation.kind === 'crop') {
        return {
          ...annotation,
          width: clamp(annotation.width + deltaX, 1, 100 - annotation.x),
          height: clamp(annotation.height + deltaY, 1, 100 - annotation.y),
        };
      }

      if (annotation.kind === 'arrow') {
        return {
          ...annotation,
          endX: clamp(annotation.endX + deltaX, 0, 100),
          endY: clamp(annotation.endY + deltaY, 0, 100),
        };
      }

      return annotation;
    });
  }

  function removeSelectedAnnotation() {
    if (!selectedAnnotationId) {
      return;
    }

    const selectedIndex = clip.annotations.findIndex((annotation) => annotation.id === selectedAnnotationId);
    const remainingAnnotations = clip.annotations.filter((annotation) => annotation.id !== selectedAnnotationId);
    onChange(remainingAnnotations);
    setSelectedAnnotationId(
      remainingAnnotations[Math.min(selectedIndex, remainingAnnotations.length - 1)]?.id ?? null,
    );
  }

  function handleStageKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === '[') {
      event.preventDefault();
      cycleSelectedAnnotation(-1);
      return;
    }

    if (event.key === ']') {
      event.preventDefault();
      cycleSelectedAnnotation(1);
      return;
    }

    if ((event.key === 'Backspace' || event.key === 'Delete') && clip.annotations.length > 0) {
      event.preventDefault();
      if (selectedAnnotationId) {
        removeSelectedAnnotation();
        return;
      }

      onChange(clip.annotations.slice(0, -1));
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setStartPoint(null);
      setDraftShape(null);
      setMovingAnnotation(null);
      closeTextComposer();
      return;
    }

    if (textComposer) {
      return;
    }

    if (event.key === 't' || event.key === 'T') {
      event.preventDefault();
      setActiveTool('text');
      return;
    }

    if (event.key === 'b' || event.key === 'B') {
      event.preventDefault();
      setActiveTool('box');
      return;
    }

    if (event.key === 'a' || event.key === 'A') {
      event.preventDefault();
      setActiveTool('arrow');
      return;
    }

    if (event.key === 'c' || event.key === 'C') {
      event.preventDefault();
      setActiveTool('crop');
      return;
    }

    if (!selectedAnnotation) {
      return;
    }

    const delta = event.shiftKey ? 1.5 : 1;
    const resize = event.shiftKey;

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      nudgeSelectedAnnotation(-delta, 0, resize);
      return;
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      nudgeSelectedAnnotation(delta, 0, resize);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      nudgeSelectedAnnotation(0, -delta, resize);
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      nudgeSelectedAnnotation(0, delta, resize);
    }
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!containerRef.current) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest('button, textarea')) {
      return;
    }

    event.preventDefault();

    const rect = containerRef.current.getBoundingClientRect();
    const point = toPercentPoint(event.clientX, event.clientY, rect);
    closeTextComposer();

    const hitAnnotation = hitTestAnnotation(clip.annotations, point);
    if (hitAnnotation) {
      event.currentTarget.setPointerCapture(event.pointerId);
      setSelectedAnnotationId(hitAnnotation.annotation.id);
      setMovingAnnotation({
        id: hitAnnotation.annotation.id,
        mode: hitAnnotation.mode,
        startPoint: point,
        original: hitAnnotation.annotation,
      });
      setStartPoint(null);
      setDraftShape(null);
      return;
    }

    if (activeTool === 'text') {
      setStartPoint(null);
      setDraftShape(null);
      setSelectedAnnotationId(null);
      openTextComposer(event.clientX, event.clientY, rect);
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    setStartPoint({
      x: clamp(event.clientX - rect.left, 0, rect.width),
      y: clamp(event.clientY - rect.top, 0, rect.height),
    });
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!containerRef.current) {
      return;
    }

    const rect = containerRef.current.getBoundingClientRect();

    if (movingAnnotation) {
      const point = toPercentPoint(event.clientX, event.clientY, rect);
      const deltaX = point.x - movingAnnotation.startPoint.x;
      const deltaY = point.y - movingAnnotation.startPoint.y;
      onChange(
        clip.annotations.map((annotation) =>
          annotation.id === movingAnnotation.id
            ? movingAnnotation.mode === 'move'
              ? translateAnnotation(movingAnnotation.original, deltaX, deltaY)
              : movingAnnotation.mode === 'resize-box' &&
                  (movingAnnotation.original.kind === 'box' ||
                    movingAnnotation.original.kind === 'crop')
                ? {
                    ...movingAnnotation.original,
                    width: clamp(point.x - movingAnnotation.original.x, 1, 100 - movingAnnotation.original.x),
                    height: clamp(point.y - movingAnnotation.original.y, 1, 100 - movingAnnotation.original.y),
                  }
                : movingAnnotation.mode === 'resize-arrow-start' &&
                    movingAnnotation.original.kind === 'arrow'
                  ? {
                      ...movingAnnotation.original,
                      startX: clamp(point.x, 0, 100),
                      startY: clamp(point.y, 0, 100),
                    }
                  : movingAnnotation.mode === 'resize-arrow-end' && movingAnnotation.original.kind === 'arrow'
                    ? {
                        ...movingAnnotation.original,
                        endX: clamp(point.x, 0, 100),
                        endY: clamp(point.y, 0, 100),
                      }
                    : annotation
            : annotation,
        ),
      );
      return;
    }

    if (!startPoint) {
      return;
    }

    if (activeTool === 'box') {
      setDraftShape({
        kind: 'box',
        ...toPercentRect(startPoint.x, startPoint.y, event.clientX, event.clientY, rect),
      });
      return;
    }

    if (activeTool === 'crop') {
      setDraftShape({
        kind: 'crop',
        ...toPercentRect(startPoint.x, startPoint.y, event.clientX, event.clientY, rect),
      });
      return;
    }

    if (activeTool === 'arrow') {
      const start = {
        x: (startPoint.x / rect.width) * 100,
        y: (startPoint.y / rect.height) * 100,
      };
      const end = toPercentPoint(event.clientX, event.clientY, rect);
      setDraftShape({
        kind: 'arrow',
        startX: start.x,
        startY: start.y,
        endX: end.x,
        endY: end.y,
      });
    }
  }

  function finishPointer(event: React.PointerEvent<HTMLDivElement>) {
    if (movingAnnotation) {
      event.preventDefault();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      // Commit resize-box for blur/crop the same way as box
      if (movingAnnotation.mode === 'resize-box' && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const point = toPercentPoint(event.clientX, event.clientY, rect);
        const original = movingAnnotation.original;
        if (original.kind === 'crop') {
          onChange(
            clip.annotations.map((annotation) =>
              annotation.id === movingAnnotation.id
                ? {
                    ...original,
                    width: clamp(point.x - original.x, 1, 100 - original.x),
                    height: clamp(point.y - original.y, 1, 100 - original.y),
                  }
                : annotation,
            ),
          );
        }
      }
      setMovingAnnotation(null);
      return;
    }

    if (!startPoint || !containerRef.current) {
      return;
    }

    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const rect = containerRef.current.getBoundingClientRect();

    if (activeTool === 'box' || activeTool === 'crop') {
      const nextRect = toPercentRect(startPoint.x, startPoint.y, event.clientX, event.clientY, rect);
      setStartPoint(null);
      setDraftShape(null);

      if (nextRect.width < 1 || nextRect.height < 1) {
        return;
      }

      const nextAnnotation: ClipAnnotation =
        activeTool === 'crop'
          ? { id: `annotation_${Date.now()}`, kind: 'crop', ...nextRect }
          : { id: `annotation_${Date.now()}`, kind: 'box', color: '#E8960A', ...nextRect };

      onChange([...clip.annotations, nextAnnotation]);
      setSelectedAnnotationId(nextAnnotation.id);
      return;
    }

    const start = {
      x: (startPoint.x / rect.width) * 100,
      y: (startPoint.y / rect.height) * 100,
    };
    const end = toPercentPoint(event.clientX, event.clientY, rect);
    setStartPoint(null);
    setDraftShape(null);

    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    if (distance < 1.2) {
      return;
    }

    const nextAnnotation: ClipAnnotation = {
      id: `annotation_${Date.now()}`,
      kind: 'arrow',
      color: '#CC2B2B',
      startX: start.x,
      startY: start.y,
      endX: end.x,
      endY: end.y,
    };
    onChange([...clip.annotations, nextAnnotation]);
    setSelectedAnnotationId(nextAnnotation.id);
  }

  return (
    <section className="annotation-shell">
      <div
        aria-label="Annotation tools"
        role="toolbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '2px',
          padding: '4px 8px',
          background: '#F6F4F0',
          borderBottom: '1px solid #E4DED8',
          flexShrink: 0,
        }}
      >
        <ToolButton isActive={activeTool === 'box'} keyHint="B" label="⊡ Box" onClick={() => setActiveTool('box')} />
        <ToolButton isActive={activeTool === 'arrow'} keyHint="A" label="↗ Arrow" onClick={() => setActiveTool('arrow')} />
        <ToolButton isActive={activeTool === 'text'} keyHint="T" label="T Text" onClick={() => setActiveTool('text')} />
        <ToolButton isActive={activeTool === 'crop'} keyHint="C" label="✂ Crop" onClick={() => setActiveTool('crop')} />
        <ToolButton
          disabled={clip.annotations.length === 0}
          label="Undo"
          onClick={() => onChange(clip.annotations.slice(0, -1))}
          style={{ marginLeft: 'auto' }}
        />
      </div>

      {clip.annotations.length ? (
        <div className="annotation-selection-bar">
          <div className="annotation-selection-copy">
            <span className="annotation-selection-label">Selected</span>
            <strong>
              {selectedAnnotation
                ? `${selectedAnnotation.kind} ${clip.annotations.findIndex((annotation) => annotation.id === selectedAnnotation.id) + 1}`
                : 'No annotation selected'}
            </strong>
          </div>
          <div className="annotation-selection-actions">
            <button className="secondary" onClick={() => cycleSelectedAnnotation(-1)} type="button">
              Previous
            </button>
            <button className="secondary" onClick={() => cycleSelectedAnnotation(1)} type="button">
              Next
            </button>
            <button className="secondary" disabled={!selectedAnnotation} onClick={removeSelectedAnnotation} type="button">
              Delete
            </button>
          </div>
        </div>
      ) : null}

      <div
        aria-label="Annotation canvas. Press T for text, B for box, A for arrow, C for crop, brackets to change selection, arrow keys to move the selected annotation, Shift plus arrow keys to resize it, Delete to remove it, and Escape to cancel."
        className="annotation-stage annotation-stage-drawing"
        onKeyDown={handleStageKeyDown}
        onPointerCancel={finishPointer}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointer}
        ref={containerRef}
        tabIndex={0}
      >
        {imageUrl ? (
          <img alt={clip.title} className="annotation-image" src={imageUrl} />
        ) : (
          <div className="annotation-image annotation-image-loading">Loading clip image...</div>
        )}

        {textComposer ? (
          <div
            className="annotation-text-composer"
            style={{ left: textComposer.left, top: textComposer.top }}
          >
            <div
              className="annotation-text-composer-header"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setComposerDragOffset({
                  x: event.clientX - textComposer.left,
                  y: event.clientY - textComposer.top,
                });
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (!composerDragOffset || !containerRef.current) {
                  return;
                }

                const rect = containerRef.current.getBoundingClientRect();
                const nextLeft = clamp(
                  event.clientX - composerDragOffset.x,
                  12,
                  Math.max(12, rect.width - 260 - 12),
                );
                const nextTop = clamp(event.clientY - composerDragOffset.y, 12, Math.max(12, rect.height - 160));
                setTextComposer((currentValue) =>
                  currentValue
                    ? {
                        ...currentValue,
                        left: nextLeft,
                        top: nextTop,
                      }
                    : currentValue,
                );
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                setComposerDragOffset(null);
              }}
            >
              <span>Text annotation</span>
              <button
                aria-label="Close text annotation composer"
                className="annotation-text-composer-close"
                onClick={closeTextComposer}
                type="button"
              >
                X
              </button>
            </div>
            <textarea
              autoFocus
              className="annotation-text-composer-input"
              onChange={(event) =>
                setTextComposer((currentValue) =>
                  currentValue
                    ? {
                        ...currentValue,
                        text: event.target.value,
                      }
                    : currentValue,
                )
              }
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  saveTextComposer();
                  return;
                }

                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeTextComposer();
                }
              }}
              placeholder="Type a note"
              rows={3}
              value={textComposer.text}
            />
            <div className="annotation-text-composer-actions">
              <button onClick={saveTextComposer} type="button">
                Add text
              </button>
              <button className="secondary" onClick={closeTextComposer} type="button">
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        <svg className="annotation-overlay" preserveAspectRatio="none" viewBox="0 0 100 100">
          {previewAnnotations.map((annotation) => {
            const isSelected = annotation.id === selectedAnnotationId;

            if (annotation.kind === 'box') {
              return (
                <g key={annotation.id}>
                  <rect
                    fill={`${annotation.color}11`}
                    height={annotation.height}
                    rx="1.4"
                    ry="1.4"
                    stroke={annotation.color}
                    strokeWidth="0.45"
                    width={annotation.width}
                    x={annotation.x}
                    y={annotation.y}
                  />
                  {isSelected ? (
                    <>
                      <rect
                        fill="none"
                        height={annotation.height}
                        rx="1.8"
                        ry="1.8"
                        stroke="#70c8ff"
                        strokeDasharray="1.6 1.1"
                        strokeWidth="0.32"
                        width={annotation.width}
                        x={annotation.x}
                        y={annotation.y}
                      />
                      <circle
                        cx={annotation.x + annotation.width}
                        cy={annotation.y + annotation.height}
                        fill="#70c8ff"
                        r="0.9"
                      />
                    </>
                  ) : null}
                </g>
              );
            }

            if (annotation.kind === 'arrow') {
              return (
                <g key={annotation.id}>
                  <line
                    markerEnd={`url(#arrowhead-${annotation.id})`}
                    stroke={annotation.color}
                    strokeLinecap="round"
                    strokeWidth="0.7"
                    x1={annotation.startX}
                    x2={annotation.endX}
                    y1={annotation.startY}
                    y2={annotation.endY}
                  />
                  <defs>
                    <marker
                      id={`arrowhead-${annotation.id}`}
                      markerHeight="6"
                      markerWidth="6"
                      orient="auto"
                      refX="5"
                      refY="3"
                    >
                      <path d="M0,0 L6,3 L0,6 z" fill={annotation.color} />
                    </marker>
                  </defs>
                  {isSelected ? (
                    <>
                      <circle cx={annotation.startX} cy={annotation.startY} fill="#70c8ff" r="0.9" />
                      <circle cx={annotation.endX} cy={annotation.endY} fill="#70c8ff" r="0.9" />
                    </>
                  ) : null}
                </g>
              );
            }

            if (annotation.kind === 'crop') {
              return (
                <g key={annotation.id}>
                  {/* Dark overlay outside the crop region — four rectangles around the crop rect */}
                  {/* Top */}
                  <rect fill="rgba(0,0,0,0.4)" height={annotation.y} width="100" x="0" y="0" />
                  {/* Bottom */}
                  <rect
                    fill="rgba(0,0,0,0.4)"
                    height={100 - annotation.y - annotation.height}
                    width="100"
                    x="0"
                    y={annotation.y + annotation.height}
                  />
                  {/* Left */}
                  <rect
                    fill="rgba(0,0,0,0.4)"
                    height={annotation.height}
                    width={annotation.x}
                    x="0"
                    y={annotation.y}
                  />
                  {/* Right */}
                  <rect
                    fill="rgba(0,0,0,0.4)"
                    height={annotation.height}
                    width={100 - annotation.x - annotation.width}
                    x={annotation.x + annotation.width}
                    y={annotation.y}
                  />
                  <rect
                    fill="none"
                    height={annotation.height}
                    rx="1.4"
                    ry="1.4"
                    stroke="#15783D"
                    strokeDasharray="2.2 1.4"
                    strokeWidth="0.5"
                    width={annotation.width}
                    x={annotation.x}
                    y={annotation.y}
                  />
                  {isSelected ? (
                    <>
                      <rect
                        fill="none"
                        height={annotation.height}
                        rx="1.8"
                        ry="1.8"
                        stroke="#70c8ff"
                        strokeDasharray="1.6 1.1"
                        strokeWidth="0.32"
                        width={annotation.width}
                        x={annotation.x}
                        y={annotation.y}
                      />
                      <circle
                        cx={annotation.x + annotation.width}
                        cy={annotation.y + annotation.height}
                        fill="#70c8ff"
                        r="0.9"
                      />
                    </>
                  ) : null}
                </g>
              );
            }

            const textSize = getTextAnnotationSize(annotation.text);

            return (
              <foreignObject
                height={textSize.height}
                key={annotation.id}
                width={textSize.width}
                x={annotation.x}
                y={annotation.y - 6}
              >
                <div className={`annotation-text-tag ${isSelected ? 'annotation-text-tag-selected' : ''}`}>
                  {annotation.text}
                </div>
              </foreignObject>
            );
          })}

          {draftShape?.kind === 'box' ? (
            <rect
              fill="#E8960A11"
              height={draftShape.height}
              rx="1.4"
              ry="1.4"
              stroke="#E8960A"
              strokeDasharray="2 1.5"
              strokeWidth="0.45"
              width={draftShape.width}
              x={draftShape.x}
              y={draftShape.y}
            />
          ) : null}

          {draftShape?.kind === 'arrow' ? (
            <line
              stroke="#CC2B2B"
              strokeDasharray="2 1.5"
              strokeLinecap="round"
              strokeWidth="0.7"
              x1={draftShape.startX}
              x2={draftShape.endX}
              y1={draftShape.startY}
              y2={draftShape.endY}
            />
          ) : null}

          {draftShape?.kind === 'crop' ? (
            <g>
              {/* Top */}
              <rect fill="rgba(0,0,0,0.3)" height={draftShape.y} width="100" x="0" y="0" />
              {/* Bottom */}
              <rect
                fill="rgba(0,0,0,0.3)"
                height={100 - draftShape.y - draftShape.height}
                width="100"
                x="0"
                y={draftShape.y + draftShape.height}
              />
              {/* Left */}
              <rect
                fill="rgba(0,0,0,0.3)"
                height={draftShape.height}
                width={draftShape.x}
                x="0"
                y={draftShape.y}
              />
              {/* Right */}
              <rect
                fill="rgba(0,0,0,0.3)"
                height={draftShape.height}
                width={100 - draftShape.x - draftShape.width}
                x={draftShape.x + draftShape.width}
                y={draftShape.y}
              />
              <rect
                fill="none"
                height={draftShape.height}
                rx="1.4"
                ry="1.4"
                stroke="#15783D"
                strokeDasharray="2.2 1.4"
                strokeWidth="0.5"
                width={draftShape.width}
                x={draftShape.x}
                y={draftShape.y}
              />
            </g>
          ) : null}
        </svg>
      </div>
    </section>
  );
}
