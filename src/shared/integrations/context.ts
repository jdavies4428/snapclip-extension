import type { ClipRecord } from '../types/session';
import { normalizeRuntimeContext, redactUrlQuery, sanitizeEvidenceText } from '../export/evidence';

export type ClipContext = {
  clipId: string;
  title: string;
  pageUrl: string;
  pageTitle: string;
  note: string;
  consoleErrors: string[];
  networkFailures: string[];
  viewport: string;
  timestamp: string;
  clipMode: string;
  attribution: string;
};

const ATTRIBUTION = 'Captured with LLM Clip';

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function formatClipContext(clip: ClipRecord): ClipContext {
  const runtimeContext = normalizeRuntimeContext(clip.runtimeContext, 'balanced');
  const consoleErrors = (runtimeContext?.events ?? [])
    .filter((event) => event.level === 'error')
    .map((event) => truncate(sanitizeEvidenceText(event.message), 180))
    .slice(0, 4);

  const networkFailures = (runtimeContext?.network ?? [])
    .filter((request) => request.classification === 'failed')
    .map((request) => {
      const status = request.status === null ? 'ERR' : String(request.status);
      return `${request.method.toUpperCase()} ${redactUrlQuery(request.url)} → ${status}`;
    })
    .slice(0, 4);

  return {
    clipId: clip.id,
    title: clip.title.trim() || 'Untitled clip',
    pageUrl: redactUrlQuery(clip.page.url),
    pageTitle: truncate(sanitizeEvidenceText(clip.page.title || 'Untitled page'), 140),
    note: truncate(sanitizeEvidenceText(clip.note || ''), 400),
    consoleErrors,
    networkFailures,
    viewport: `${clip.page.viewport.width}×${clip.page.viewport.height} @${clip.page.viewport.dpr}x`,
    timestamp: clip.createdAt,
    clipMode: clip.clipMode,
    attribution: ATTRIBUTION,
  };
}
