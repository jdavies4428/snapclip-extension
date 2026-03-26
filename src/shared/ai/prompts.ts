import type { ClipSession, RuntimeContext } from '../types/session';
import type { HandoffIntent, HandoffPackageMode, HandoffTarget } from '../bridge/client';
import { buildActionTimeline, redactUrlQuery, sanitizeEvidenceText, type EvidenceProfile } from '../export/evidence';

export type HandoffScope = 'active_clip' | 'session';

type PromptParams = {
  scope: HandoffScope;
  target: HandoffTarget;
  intent: HandoffIntent;
  packageMode: HandoffPackageMode;
  evidenceProfile: EvidenceProfile;
  activeClip: {
    title: string;
    note?: string;
    createdAt: string;
    page: {
      url: string;
    };
    runtimeContext: RuntimeContext | null;
  };
  session: ClipSession;
  contextFileName?: string;
  annotationsFileName?: string;
  screenshotFileName?: string;
  annotatedFileName?: string;
  clipsManifestFileName?: string;
};

function summarizeRuntime(runtimeContext: RuntimeContext | null): string[] {
  if (!runtimeContext) {
    return ['- No runtime evidence was attached to this packet.'];
  }

  const summary = [
    `- Runtime events: ${runtimeContext.summary.eventCount}`,
    `- Runtime errors: ${runtimeContext.summary.errorCount}`,
    `- Runtime warnings: ${runtimeContext.summary.warningCount}`,
    `- Failed requests: ${runtimeContext.summary.failedRequestCount}`,
    `- Slow requests: ${runtimeContext.summary.slowRequestCount}`,
  ];

  if (runtimeContext.chromeDebugger) {
    const requestHeaderCount = runtimeContext.chromeDebugger.network.reduce(
      (sum, request) => sum + (request.requestHeaders?.length ?? 0),
      0,
    );
    const responseHeaderCount = runtimeContext.chromeDebugger.network.reduce(
      (sum, request) => sum + (request.responseHeaders?.length ?? 0),
      0,
    );
    summary.push(
      `- Chrome debugger snapshot: ${runtimeContext.chromeDebugger.attachError || 'attached'}`,
      `- Chrome debugger frames: ${runtimeContext.chromeDebugger.frameCount}`,
      `- Chrome debugger DOM nodes: ${runtimeContext.chromeDebugger.performance.nodes ?? 'n/a'}`,
      `- Chrome debugger JS heap used: ${runtimeContext.chromeDebugger.performance.jsHeapUsedSize ?? 'n/a'}`,
      `- Chrome debugger logs: ${runtimeContext.chromeDebugger.logs.length}`,
      `- Chrome debugger requests: ${runtimeContext.chromeDebugger.network.length}`,
      `- Chrome debugger request headers retained: ${requestHeaderCount}`,
      `- Chrome debugger response headers retained: ${responseHeaderCount}`,
    );
  }

  return summary;
}

function summarizeActions(activeClip: PromptParams['activeClip']): string[] {
  const timeline = buildActionTimeline(activeClip, 6);
  if (!timeline.length) {
    return ['- No bounded action timeline was available for this clip.'];
  }

  return timeline.map((entry) => `- [${entry.tone.toUpperCase()}] ${entry.label}: ${entry.detail}`);
}

function describeRequestedAction(intent: HandoffIntent): string {
  switch (intent) {
    case 'explain':
      return 'Explain the likely issue, point to the relevant code, and call out any uncertainty.';
    case 'plan':
      return 'Produce the shortest defensible investigation and fix plan without guessing.';
    default:
      return 'Investigate the issue and implement a fix if the cause is clear. If not, give the next best investigation steps.';
  }
}

function buildPromptHeader(params: PromptParams): string[] {
  const contextFileName = params.contextFileName ?? 'context.json';
  const annotationsFileName = params.annotationsFileName ?? 'annotations.json';
  const screenshotFileName = params.screenshotFileName ?? 'screenshot.png';
  const annotatedFileName = params.annotatedFileName ?? 'annotated.png';
  const clipsManifestFileName = params.clipsManifestFileName ?? 'clips_manifest.json';

  return [
    '# LLM Clip Incident Packet',
    '',
    `- Target: ${params.target}`,
    `- Package mode: ${params.packageMode}`,
    `- Evidence profile: ${params.evidenceProfile}`,
    `- Scope: ${params.scope === 'session' ? `session (${params.session.clips.length} clips)` : 'active clip'}`,
    `- Active clip: ${sanitizeEvidenceText(params.activeClip.title)}`,
    `- URL: ${redactUrlQuery(params.activeClip.page.url)}`,
    `- Captured at: ${params.activeClip.createdAt}`,
    '',
    'Read these files before responding:',
    `- \`${screenshotFileName}\` — the raw captured active clip image`,
    `- \`${annotatedFileName}\` — the active clip with drawn annotations`,
    ...(params.scope === 'session'
      ? [
          '- `clips/` — all saved clip image pairs, ordered newest-first as numbered folders',
          `- \`${clipsManifestFileName}\` — the exact image-to-title-to-note pairing for every saved clip`,
        ]
      : []),
    ...(params.packageMode === 'packet'
      ? [
          `- \`${contextFileName}\` — structured page, runtime, and Chrome debugger evidence`,
          `- \`${annotationsFileName}\` — the annotation geometry and note metadata`,
        ]
      : []),
    '',
  ];
}

export function createClaudePrompt(params: PromptParams): string {
  return [
    ...buildPromptHeader(params),
    'Primary user instructions:',
    params.activeClip.note?.trim()
      ? params.activeClip.note.trim()
      : 'Investigate what is visible in the capture and respond based on the attached evidence.',
    '',
    params.scope === 'session'
      ? 'Treat the bundle as an ordered image sequence. Compare all saved clips in `clips/` before you decide what changed or what is broken.'
      : 'Focus on the active clip image first.',
    params.scope === 'session'
      ? 'Use `clips_manifest.json` as the source of truth for which note belongs to which image pair.'
      : 'Use the active clip note as the primary instruction for this image.',
    params.packageMode === 'packet'
      ? 'Then use the structured context and runtime evidence to confirm or reject hypotheses.'
      : 'Stay image-first. Only rely on the visual evidence in the attached images.',
    '',
    ...(params.packageMode === 'packet'
      ? [
          'Runtime evidence summary:',
          ...summarizeRuntime(params.activeClip.runtimeContext),
          '',
          'Action timeline summary:',
          ...summarizeActions(params.activeClip),
          '',
        ]
      : []),
    'Requested action:',
    describeRequestedAction(params.intent),
    '',
    'Query params are redacted by default in the attached evidence.',
    '',
    'Do not invent missing facts. If the evidence is insufficient, say what you need next.',
  ].join('\n');
}

export function createCodexPrompt(params: PromptParams): string {
  return [
    ...buildPromptHeader(params),
    'Primary user instructions:',
    params.activeClip.note?.trim()
      ? params.activeClip.note.trim()
      : 'Investigate what is visible in the capture and respond based on the attached evidence.',
    '',
    'Treat this as a coding incident packet. Prefer code-aware investigation and a minimal, reversible fix plan.',
    params.scope === 'session'
      ? 'Inspect the ordered image sequence in `clips/` before you infer regressions or state transitions.'
      : 'Inspect the active clip image first.',
    params.scope === 'session'
      ? 'Use `clips_manifest.json` to pair each clip note with the correct raw and annotated image files.'
      : 'Use the active clip note as the primary instruction for this image.',
    params.packageMode === 'packet'
      ? 'Use the structured packet files to confirm technical hypotheses.'
      : 'Keep the analysis image-first and avoid assuming extra runtime context.',
    '',
    ...(params.packageMode === 'packet'
      ? [
          'Runtime evidence summary:',
          ...summarizeRuntime(params.activeClip.runtimeContext),
          '',
          'Action timeline summary:',
          ...summarizeActions(params.activeClip),
          '',
        ]
      : []),
    'Requested action:',
    describeRequestedAction(params.intent),
    '',
    'Query params are redacted by default in the attached evidence.',
    '',
    'If the root cause is not clear from the bundle, list the exact repo files or runtime checks you would inspect next.',
  ].join('\n');
}
