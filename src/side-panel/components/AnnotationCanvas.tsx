import { useMemo, useRef, useState } from 'react';
import type { ClipAnnotation, ClipRecord } from '../../shared/types/session';

type AnnotationCanvasProps = {
  clip: ClipRecord;
  imageUrl: string | null;
  onChange: (annotations: ClipAnnotation[]) => void;
};

type DrawingTool = 'box' | 'arrow' | 'text';

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

function ToolButton({
  label,
  isActive,
  disabled = false,
  onClick,
}: {
  label: string;
  isActive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`annotation-tool-button ${isActive ? 'annotation-tool-button-active' : ''}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
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
}

function hitTestAnnotation(
  annotations: ClipAnnotation[],
  point: { x: number; y: number },
): { annotation: ClipAnnotation; mode: AnnotationInteractionMode } | null {
  return (
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
          const width = Math.min(42, Math.max(16, annotation.text.length * 1.5));
          const top = Math.max(0, annotation.y - 8);
          if (
            point.x >= annotation.x &&
            point.x <= Math.min(100, annotation.x + width) &&
            point.y >= top &&
            point.y <= annotation.y + 2
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
  const [textComposer, setTextComposer] = useState<TextComposerState | null>(null);
  const [composerDragOffset, setComposerDragOffset] = useState<{ x: number; y: number } | null>(null);

  const annotationColor = '#ff8a5b';

  const previewAnnotations = useMemo(() => clip.annotations, [clip.annotations]);

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

    onChange([
      ...clip.annotations,
      {
        id: `annotation_${Date.now()}`,
        kind: 'text',
        color: annotationColor,
        text: textComposer.text.trim(),
        x: textComposer.x,
        y: textComposer.y,
      },
    ]);
    setActiveTool('box');
    closeTextComposer();
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
              : movingAnnotation.mode === 'resize-box' && movingAnnotation.original.kind === 'box'
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

    if (activeTool === 'box') {
      const nextRect = toPercentRect(startPoint.x, startPoint.y, event.clientX, event.clientY, rect);
      setStartPoint(null);
      setDraftShape(null);

      if (nextRect.width < 1 || nextRect.height < 1) {
        return;
      }

      onChange([
        ...clip.annotations,
        {
          id: `annotation_${Date.now()}`,
          kind: 'box',
          color: annotationColor,
          ...nextRect,
        },
      ]);
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

    onChange([
      ...clip.annotations,
      {
        id: `annotation_${Date.now()}`,
        kind: 'arrow',
        color: annotationColor,
        startX: start.x,
        startY: start.y,
        endX: end.x,
        endY: end.y,
      },
    ]);
  }

  return (
    <section className="annotation-shell">
      <div className="annotation-toolbar">
        <ToolButton isActive={activeTool === 'text'} label="Text" onClick={() => setActiveTool('text')} />
        <ToolButton isActive={activeTool === 'box'} label="Box" onClick={() => setActiveTool('box')} />
        <ToolButton isActive={activeTool === 'arrow'} label="Arrow" onClick={() => setActiveTool('arrow')} />
        <ToolButton
          disabled={clip.annotations.length === 0}
          label="Undo"
          onClick={() => onChange(clip.annotations.slice(0, -1))}
        />
      </div>

      <div
        className="annotation-stage annotation-stage-drawing"
        onPointerCancel={finishPointer}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointer}
        ref={containerRef}
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
                className="annotation-text-composer-close"
                onClick={closeTextComposer}
                type="button"
              >
                X
              </button>
            </div>
            <textarea
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
                </g>
              );
            }

            return (
              <foreignObject height="20" key={annotation.id} width="60" x={annotation.x} y={annotation.y - 6}>
                <div className="annotation-text-tag">{annotation.text}</div>
              </foreignObject>
            );
          })}

          {draftShape?.kind === 'box' ? (
            <rect
              fill="#ff8a5b11"
              height={draftShape.height}
              rx="1.4"
              ry="1.4"
              stroke="#ff8a5b"
              strokeDasharray="2 1.5"
              strokeWidth="0.45"
              width={draftShape.width}
              x={draftShape.x}
              y={draftShape.y}
            />
          ) : null}

          {draftShape?.kind === 'arrow' ? (
            <line
              stroke="#ff8a5b"
              strokeDasharray="2 1.5"
              strokeLinecap="round"
              strokeWidth="0.7"
              x1={draftShape.startX}
              x2={draftShape.endX}
              y1={draftShape.startY}
              y2={draftShape.endY}
            />
          ) : null}
        </svg>
      </div>
    </section>
  );
}
