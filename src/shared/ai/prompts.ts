import type { ClipRecord, ClipSession, RuntimeContext } from '../types/session';
import type { HandoffIntent, HandoffTarget } from '../bridge/client';
import { redactUrlQuery, sanitizeEvidenceText, type EvidenceProfile } from '../export/evidence';

export type HandoffScope = 'active_clip' | 'session';

type PromptParams = {
  scope: HandoffScope;
  target: HandoffTarget;
  intent: HandoffIntent;
  evidenceProfile: EvidenceProfile;
  activeClip: ClipRecord;
  session: ClipSession;
  contextFileName?: string;
  annotationsFileName?: string;
  screenshotFileName?: string;
  annotatedFileName?: string;
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
    summary.push(
      `- Chrome debugger snapshot: ${runtimeContext.chromeDebugger.attachError || 'attached'}`,
      `- Chrome debugger frames: ${runtimeContext.chromeDebugger.frameCount}`,
      `- Chrome debugger DOM nodes: ${runtimeContext.chromeDebugger.performance.nodes ?? 'n/a'}`,
      `- Chrome debugger JS heap used: ${runtimeContext.chromeDebugger.performance.jsHeapUsedSize ?? 'n/a'}`,
      `- Chrome debugger logs: ${runtimeContext.chromeDebugger.logs.length}`,
      `- Chrome debugger requests: ${runtimeContext.chromeDebugger.network.length}`,
    );
  }

  return summary;
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

  return [
    '# LLM Clip Incident Packet',
    '',
    `- Target: ${params.target}`,
    `- Evidence profile: ${params.evidenceProfile}`,
    `- Scope: ${params.scope === 'session' ? `session (${params.session.clips.length} clips)` : 'active clip'}`,
    `- Active clip: ${sanitizeEvidenceText(params.activeClip.title)}`,
    `- URL: ${redactUrlQuery(params.activeClip.page.url)}`,
    `- Captured at: ${params.activeClip.createdAt}`,
    '',
    'Read these files before responding:',
    `- \`${contextFileName}\``,
    `- \`${annotationsFileName}\``,
    `- \`${screenshotFileName}\``,
    `- \`${annotatedFileName}\``,
    '',
  ];
}

export function createClaudePrompt(params: PromptParams): string {
  return [
    ...buildPromptHeader(params),
    'Focus on the screenshot and annotations first, then use the structured context and runtime evidence to confirm or reject hypotheses.',
    '',
    'Runtime evidence summary:',
    ...summarizeRuntime(params.activeClip.runtimeContext),
    '',
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
    'Treat this as a coding incident packet. Prefer code-aware investigation and a minimal, reversible fix plan.',
    '',
    'Runtime evidence summary:',
    ...summarizeRuntime(params.activeClip.runtimeContext),
    '',
    'Requested action:',
    describeRequestedAction(params.intent),
    '',
    'Query params are redacted by default in the attached evidence.',
    '',
    'If the root cause is not clear from the bundle, list the exact repo files or runtime checks you would inspect next.',
  ].join('\n');
}
