import type { ChromeDebuggerHeader, ClipRecord, NetworkRequest, RuntimeContext, RuntimeEvent } from '../types/session';

export type EvidenceProfile = 'lean' | 'balanced' | 'full';
export type ActionTimelineEntry = {
  id: string;
  kind: 'route' | 'request_failed' | 'request_slow';
  tone: 'error' | 'warn' | 'log';
  label: string;
  detail: string;
  timestamp: string;
};

type RuntimeLimits = {
  maxEvents: number;
  maxNetwork: number;
  maxHeaders: number;
  maxHeadings: number;
  maxButtons: number;
  maxFields: number;
  maxSelectedTextLength: number;
  maxEventMessageLength: number;
  maxNetworkErrorLength: number;
  maxHeaderValueLength: number;
};

const PROFILE_LIMITS: Record<EvidenceProfile, RuntimeLimits> = {
  lean: {
    maxEvents: 1,
    maxNetwork: 2,
    maxHeaders: 4,
    maxHeadings: 2,
    maxButtons: 3,
    maxFields: 3,
    maxSelectedTextLength: 140,
    maxEventMessageLength: 120,
    maxNetworkErrorLength: 100,
    maxHeaderValueLength: 80,
  },
  balanced: {
    maxEvents: 4,
    maxNetwork: 4,
    maxHeaders: 8,
    maxHeadings: 4,
    maxButtons: 5,
    maxFields: 5,
    maxSelectedTextLength: 260,
    maxEventMessageLength: 180,
    maxNetworkErrorLength: 150,
    maxHeaderValueLength: 120,
  },
  full: {
    maxEvents: 8,
    maxNetwork: 12,
    maxHeaders: 14,
    maxHeadings: 6,
    maxButtons: 8,
    maxFields: 8,
    maxSelectedTextLength: 400,
    maxEventMessageLength: 260,
    maxNetworkErrorLength: 220,
    maxHeaderValueLength: 180,
  },
};

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
]);

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function maskEmails(value: string): string {
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]');
}

function redactKeyValueSecrets(value: string): string {
  return value.replace(
    /\b(token|api[_-]?key|secret|session|auth)=([^&\s]+)/gi,
    (_match, key) => `${key}=[redacted]`,
  );
}

function redactEmbeddedUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s)]+/gi, (match) => redactUrlQuery(match));
}

export function sanitizeEvidenceText(value: string): string {
  return redactKeyValueSecrets(redactEmbeddedUrls(maskEmails(value)));
}

function truncate(value: string, maxLength: number): string {
  const normalized = compactWhitespace(sanitizeEvidenceText(value));
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function redactUrlQuery(url: string): string {
  try {
    const parsed = new URL(url);
    const hasQuery = parsed.search.length > 0;
    const hasHash = parsed.hash.length > 0;
    return `${parsed.origin}${parsed.pathname}${hasQuery ? '?[redacted]' : ''}${hasHash ? '#[redacted]' : ''}`;
  } catch {
    const [withoutHash] = String(url).split('#', 1);
    const [base] = withoutHash.split('?', 1);
    return `${base || url}${String(url).includes('?') ? '?[redacted]' : ''}${String(url).includes('#') ? '#[redacted]' : ''}`;
  }
}

function formatActionLocation(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.pathname || '/'}${parsed.search ? '?[redacted]' : ''}`;
  } catch {
    return truncate(value, 120);
  }
}

function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    SENSITIVE_HEADER_NAMES.has(normalized) ||
    /(token|secret|session|csrf|xsrf|auth)/i.test(normalized)
  );
}

export function sanitizeDebuggerHeader(
  header: ChromeDebuggerHeader,
  maxValueLength: number,
): ChromeDebuggerHeader {
  if (isSensitiveHeaderName(header.name)) {
    return {
      name: header.name,
      value: '[redacted]',
      redacted: true,
    };
  }

  return {
    name: truncate(header.name, 80),
    value: truncate(header.value, maxValueLength),
    redacted: Boolean(header.redacted),
  };
}

export function sanitizeDebuggerHeaders(
  headers: ChromeDebuggerHeader[],
  maxHeaders: number,
  maxValueLength: number,
): { headers: ChromeDebuggerHeader[]; isTruncated: boolean } {
  const sanitized = headers.slice(0, maxHeaders).map((header) => sanitizeDebuggerHeader(header, maxValueLength));

  return {
    headers: sanitized,
    isTruncated: headers.length > maxHeaders,
  };
}

export function formatDebuggerHeadersText(headers: ChromeDebuggerHeader[]): string | null {
  if (!headers.length) {
    return null;
  }

  return headers.map((header) => `${header.name}: ${header.value}`).join('\n');
}

function dedupeRuntimeEvents(events: RuntimeEvent[]): RuntimeEvent[] {
  const seen = new Set<string>();
  const deduped: RuntimeEvent[] = [];

  for (const event of events) {
    const key = `${event.type}|${event.level}|${compactWhitespace(event.message)}|${event.source ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(event);
  }

  return deduped;
}

function dedupeNetworkRequests(requests: NetworkRequest[]): NetworkRequest[] {
  const seen = new Set<string>();
  const deduped: NetworkRequest[] = [];

  for (const request of requests) {
    const key = `${request.transport}|${request.method}|${redactUrlQuery(request.url)}|${request.status ?? 'none'}|${request.classification}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(request);
  }

  return deduped;
}

export function buildActionTimeline(clip: Pick<ClipRecord, 'runtimeContext'>, limit = 12): ActionTimelineEntry[] {
  if (!clip.runtimeContext) {
    return [];
  }

  const entries: ActionTimelineEntry[] = [];

  for (const event of clip.runtimeContext.events) {
    if (event.type !== 'route_change') {
      continue;
    }

    const routeLabel = event.url ? formatActionLocation(event.url) : truncate(event.message, 120);
    entries.push({
      id: `route-${event.timestamp}-${routeLabel}`,
      kind: 'route',
      tone: 'log',
      label: `Navigated to ${routeLabel}`,
      detail: event.title ? truncate(event.title, 120) : truncate(event.url || event.message, 180),
      timestamp: event.timestamp,
    });
  }

  for (const request of clip.runtimeContext.network) {
    if (request.classification !== 'failed' && request.classification !== 'slow') {
      continue;
    }

    const statusLabel = request.status === null ? 'no status' : String(request.status);
    const detail = request.error
      ? `${request.transport} · ${statusLabel} · ${request.durationMs}ms · ${truncate(request.error, 140)}`
      : `${request.transport} · ${statusLabel} · ${request.durationMs}ms`;

    entries.push({
      id: `request-${request.id}`,
      kind: request.classification === 'failed' ? 'request_failed' : 'request_slow',
      tone: request.classification === 'failed' ? 'error' : 'warn',
      label: `${request.classification === 'failed' ? 'Failed' : 'Slow'} ${request.method} ${formatActionLocation(
        request.url,
      )}`,
      detail,
      timestamp: request.finishedAt,
    });
  }

  const deduped = entries.filter((entry, index, collection) => {
    const firstIndex = collection.findIndex(
      (candidate) =>
        candidate.kind === entry.kind &&
        candidate.label === entry.label &&
        candidate.detail === entry.detail &&
        candidate.timestamp === entry.timestamp,
    );
    return firstIndex === index;
  });

  return deduped.sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()).slice(-limit);
}

export function normalizeRuntimeContext(
  runtimeContext: RuntimeContext | null,
  profile: EvidenceProfile,
): RuntimeContext | null {
  if (!runtimeContext) {
    return null;
  }

  const limits = PROFILE_LIMITS[profile];
  const events = dedupeRuntimeEvents(runtimeContext.events)
    .slice(0, limits.maxEvents)
    .map((event) => ({
      ...event,
      message: truncate(event.message, limits.maxEventMessageLength),
      url: event.url ? redactUrlQuery(event.url) : event.url,
      title: event.title ? truncate(event.title, 120) : event.title,
      source: event.source ? truncate(event.source, 140) : event.source,
    }));

  const network = dedupeNetworkRequests(runtimeContext.network)
    .slice(0, limits.maxNetwork)
    .map((request) => ({
      ...request,
      url: redactUrlQuery(request.url),
      error: request.error ? truncate(request.error, limits.maxNetworkErrorLength) : request.error,
    }));

  return {
    summary: {
      ...runtimeContext.summary,
      eventCount: events.length,
      errorCount: events.filter((event) => event.level === 'error').length,
      warningCount: events.filter((event) => event.level === 'warn').length,
      networkRequestCount: network.length,
      failedRequestCount: network.filter((request) => request.classification === 'failed').length,
      slowRequestCount: network.filter((request) => request.classification === 'slow').length,
    },
    events,
    network,
    domSummary: runtimeContext.domSummary
      ? {
          path: redactUrlQuery(runtimeContext.domSummary.path),
          headingTexts: runtimeContext.domSummary.headingTexts
            .map((item) => truncate(item, 120))
            .slice(0, limits.maxHeadings),
          buttonTexts: runtimeContext.domSummary.buttonTexts
            .map((item) => truncate(item, 80))
            .slice(0, limits.maxButtons),
          inputLabels: runtimeContext.domSummary.inputLabels
            .map((item) => truncate(item, 80))
            .slice(0, limits.maxFields),
        }
      : null,
    chromeDebugger: runtimeContext.chromeDebugger
      ? {
          ...runtimeContext.chromeDebugger,
          currentUrl: redactUrlQuery(runtimeContext.chromeDebugger.currentUrl),
          currentTitle: truncate(runtimeContext.chromeDebugger.currentTitle, 140),
          attachError: runtimeContext.chromeDebugger.attachError
            ? truncate(runtimeContext.chromeDebugger.attachError, 180)
            : runtimeContext.chromeDebugger.attachError,
          frames: runtimeContext.chromeDebugger.frames.slice(0, limits.maxFields).map((frame) => ({
            ...frame,
            url: redactUrlQuery(frame.url),
            domainAndRegistry: frame.domainAndRegistry ? truncate(frame.domainAndRegistry, 80) : frame.domainAndRegistry,
            unreachableUrl: frame.unreachableUrl ? redactUrlQuery(frame.unreachableUrl) : frame.unreachableUrl,
          })),
          logs: runtimeContext.chromeDebugger.logs.slice(0, limits.maxEvents).map((entry) => ({
            ...entry,
            text: truncate(entry.text, limits.maxEventMessageLength),
            url: entry.url ? redactUrlQuery(entry.url) : entry.url,
          })),
          network: runtimeContext.chromeDebugger.network.slice(0, limits.maxNetwork).map((entry) => {
            const requestHeaders = sanitizeDebuggerHeaders(
              entry.requestHeaders ?? [],
              limits.maxHeaders,
              limits.maxHeaderValueLength,
            );
            const responseHeaders = sanitizeDebuggerHeaders(
              entry.responseHeaders ?? [],
              limits.maxHeaders,
              limits.maxHeaderValueLength,
            );

            return {
              ...entry,
              url: redactUrlQuery(entry.url),
              statusText: entry.statusText ? truncate(entry.statusText, 60) : entry.statusText,
              mimeType: entry.mimeType ? truncate(entry.mimeType, 60) : entry.mimeType,
              failedReason: entry.failedReason ? truncate(entry.failedReason, limits.maxNetworkErrorLength) : entry.failedReason,
              blockedReason: entry.blockedReason ? truncate(entry.blockedReason, limits.maxNetworkErrorLength) : entry.blockedReason,
              requestHeaders: requestHeaders.headers,
              responseHeaders: responseHeaders.headers,
              requestHeadersText: formatDebuggerHeadersText(requestHeaders.headers),
              responseHeadersText: formatDebuggerHeadersText(responseHeaders.headers),
              hasRequestHeaders: Boolean(entry.hasRequestHeaders && requestHeaders.headers.length),
              hasResponseHeaders: Boolean(entry.hasResponseHeaders && responseHeaders.headers.length),
              isTruncated: Boolean(entry.isTruncated || requestHeaders.isTruncated || responseHeaders.isTruncated),
            };
          }),
        }
      : null,
  };
}

export function normalizeClipForEvidence(clip: ClipRecord, profile: EvidenceProfile) {
  const limits = PROFILE_LIMITS[profile];

  return {
    id: clip.id,
    title: truncate(clip.title, 120),
    createdAt: clip.createdAt,
    clipMode: clip.clipMode,
    page: {
      title: truncate(clip.page.title, 140),
      url: redactUrlQuery(clip.page.url),
      viewport: clip.page.viewport,
      userAgent: profile === 'full' ? truncate(clip.page.userAgent, 220) : undefined,
      platform: clip.page.platform,
      language: clip.page.language,
      timeZone: clip.page.timeZone,
    },
    crop: clip.crop,
    domSummary: {
      headings: clip.domSummary.headings.map((item) => truncate(item, 120)).slice(0, limits.maxHeadings),
      buttons: clip.domSummary.buttons.map((item) => truncate(item, 80)).slice(0, limits.maxButtons),
      fields: clip.domSummary.fields.map((item) => truncate(item, 80)).slice(0, limits.maxFields),
      selectedText: clip.domSummary.selectedText
        ? truncate(clip.domSummary.selectedText, limits.maxSelectedTextLength)
        : '',
    },
    runtimeContext: normalizeRuntimeContext(clip.runtimeContext, profile),
    note: truncate(clip.note, 400),
    annotationCount: clip.annotations.length,
  };
}

export function describeEvidenceProfile(profile: EvidenceProfile): string {
  switch (profile) {
    case 'lean':
      return 'Lean keeps only the essentials for a quick, compact incident packet.';
    case 'full':
      return 'Full keeps the richest bounded evidence set while still redacting query params by default.';
    default:
      return 'Balanced keeps enough context for most debugging handoffs without becoming noisy.';
  }
}
