import type { ClipRecord, NetworkRequest, RuntimeContext, RuntimeEvent } from '../types/session';

export type EvidenceProfile = 'lean' | 'balanced' | 'full';

type RuntimeLimits = {
  maxEvents: number;
  maxNetwork: number;
  maxHeadings: number;
  maxButtons: number;
  maxFields: number;
  maxSelectedTextLength: number;
  maxEventMessageLength: number;
  maxNetworkErrorLength: number;
};

const PROFILE_LIMITS: Record<EvidenceProfile, RuntimeLimits> = {
  lean: {
    maxEvents: 1,
    maxNetwork: 2,
    maxHeadings: 2,
    maxButtons: 3,
    maxFields: 3,
    maxSelectedTextLength: 140,
    maxEventMessageLength: 120,
    maxNetworkErrorLength: 100,
  },
  balanced: {
    maxEvents: 4,
    maxNetwork: 4,
    maxHeadings: 4,
    maxButtons: 5,
    maxFields: 5,
    maxSelectedTextLength: 260,
    maxEventMessageLength: 180,
    maxNetworkErrorLength: 150,
  },
  full: {
    maxEvents: 8,
    maxNetwork: 12,
    maxHeadings: 6,
    maxButtons: 8,
    maxFields: 8,
    maxSelectedTextLength: 400,
    maxEventMessageLength: 260,
    maxNetworkErrorLength: 220,
  },
};

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
