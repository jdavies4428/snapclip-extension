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

export function AnnotationCanvas({ clip, imageUrl, onChange }: AnnotationCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [activeTool, setActiveTool] = useState<DrawingTool>('box');
  const [draftShape, setDraftShape] = useState<DraftShape>(null);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);

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

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!containerRef.current) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const rect = containerRef.current.getBoundingClientRect();
    setStartPoint({
      x: clamp(event.clientX - rect.left, 0, rect.width),
      y: clamp(event.clientY - rect.top, 0, rect.height),
    });
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!startPoint || !containerRef.current) {
      return;
    }

    const rect = containerRef.current.getBoundingClientRect();

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
    if (!startPoint || !containerRef.current) {
      return;
    }

    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const rect = containerRef.current.getBoundingClientRect();

    if (activeTool === 'text') {
      const point = toPercentPoint(event.clientX, event.clientY, rect);
      setStartPoint(null);
      setDraftShape(null);

      const text = window.prompt('Text annotation');
      if (!text?.trim()) {
        return;
      }

      onChange([
        ...clip.annotations,
        {
          id: `annotation_${Date.now()}`,
          kind: 'text',
          color: annotationColor,
          text: text.trim(),
          x: point.x,
          y: point.y,
        },
      ]);
      return;
    }

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

        <svg className="annotation-overlay" preserveAspectRatio="none" viewBox="0 0 100 100">
          {previewAnnotations.map((annotation) => {
            if (annotation.kind === 'box') {
              return (
                <g key={annotation.id}>
                  <rect
                    fill={`${annotation.color}22`}
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
              fill="#ff8a5b22"
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
