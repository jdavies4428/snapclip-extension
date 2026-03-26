import type { ClipSession } from '../types/session';
import { buildActionTimeline, normalizeClipForEvidence, type EvidenceProfile } from './evidence';

function section(title: string, lines: string[]): string {
  return [`## ${title}`, '', ...lines, ''].join('\n');
}

export function createClipSessionMarkdown(session: ClipSession, profile: EvidenceProfile = 'balanced'): string {
  const blocks = session.clips.flatMap((clip, index) => {
    const normalizedClip = normalizeClipForEvidence(clip, profile);
    const details = [
      `- Mode: ${normalizedClip.clipMode}`,
      `- Captured: ${normalizedClip.createdAt}`,
      `- URL: ${normalizedClip.page.url}`,
      `- Viewport: ${normalizedClip.page.viewport.width} x ${normalizedClip.page.viewport.height} @ ${normalizedClip.page.viewport.dpr}x`,
      `- Region: x=${normalizedClip.crop.x}, y=${normalizedClip.crop.y}, width=${normalizedClip.crop.width}, height=${normalizedClip.crop.height}`,
      `- Annotation count: ${normalizedClip.annotationCount}`,
    ];

    const selectedText = normalizedClip.domSummary.selectedText?.trim() || 'No selected text captured.';
    const note = normalizedClip.note.trim() || 'No note added.';
    const runtimeSummary = normalizedClip.runtimeContext
      ? [
          `- Installed: ${normalizedClip.runtimeContext.summary.installedAt}`,
          `- Last seen: ${normalizedClip.runtimeContext.summary.lastSeenAt}`,
          `- Event count: ${normalizedClip.runtimeContext.summary.eventCount}`,
          `- Errors: ${normalizedClip.runtimeContext.summary.errorCount}`,
          `- Warnings: ${normalizedClip.runtimeContext.summary.warningCount}`,
        ]
      : ['- Runtime context was not captured for this clip.'];
    const runtimeEvents = normalizedClip.runtimeContext?.events.length
      ? normalizedClip.runtimeContext.events.map(
          (event) => `- [${event.level.toUpperCase()}] ${event.type}: ${event.message}`,
        )
      : ['- No recent runtime events captured.'];
    const networkRequests = normalizedClip.runtimeContext?.network.length
      ? normalizedClip.runtimeContext.network.map((request) => {
          const status = request.status === null ? 'no-status' : String(request.status);
          const error = request.error ? ` (${request.error})` : '';
          return `- [${request.classification.toUpperCase()}] ${request.method} ${request.url} -> ${status} in ${request.durationMs}ms${error}`;
        })
      : ['- No failed or slow requests captured.'];
    const visiblePageSummary = normalizedClip.runtimeContext?.domSummary
      ? [
          `- Path: ${normalizedClip.runtimeContext.domSummary.path}`,
          ...normalizedClip.runtimeContext.domSummary.headingTexts.map((item) => `- Heading: ${item}`),
          ...normalizedClip.runtimeContext.domSummary.buttonTexts.map((item) => `- Button: ${item}`),
          ...normalizedClip.runtimeContext.domSummary.inputLabels.map((item) => `- Field: ${item}`),
        ]
      : ['- No visible page summary captured.'];
    const chromeDebuggerSummary = normalizedClip.runtimeContext?.chromeDebugger
      ? [
          `- Captured at: ${normalizedClip.runtimeContext.chromeDebugger.capturedAt}`,
          `- Status: ${normalizedClip.runtimeContext.chromeDebugger.attachError || 'Captured'}`,
          `- Current URL: ${normalizedClip.runtimeContext.chromeDebugger.currentUrl}`,
          `- Current title: ${normalizedClip.runtimeContext.chromeDebugger.currentTitle}`,
          `- Frame count: ${normalizedClip.runtimeContext.chromeDebugger.frameCount}`,
          `- DOM nodes: ${normalizedClip.runtimeContext.chromeDebugger.performance.nodes ?? 'n/a'}`,
          `- JS heap used: ${normalizedClip.runtimeContext.chromeDebugger.performance.jsHeapUsedSize ?? 'n/a'}`,
          `- Chrome logs: ${normalizedClip.runtimeContext.chromeDebugger.logs.length}`,
          `- Chrome requests: ${normalizedClip.runtimeContext.chromeDebugger.network.length}`,
        ]
      : ['- No Chrome debugger snapshot captured.'];
    const chromeDebuggerLogs = normalizedClip.runtimeContext?.chromeDebugger?.logs.length
      ? normalizedClip.runtimeContext.chromeDebugger.logs.map(
          (entry) => `- [${entry.level.toUpperCase()}] ${entry.source}: ${entry.text}`,
        )
      : ['- No Chrome debugger logs captured.'];
    const chromeDebuggerNetwork = normalizedClip.runtimeContext?.chromeDebugger?.network.length
      ? normalizedClip.runtimeContext.chromeDebugger.network.map((request) => {
          const status = request.status === null || typeof request.status === 'undefined' ? 'ERR' : String(request.status);
          const extra = [
            request.mimeType,
            request.failedReason,
            request.blockedReason,
            request.hasRequestHeaders ? `${request.requestHeaders?.length ?? 0} req headers` : '',
            request.hasResponseHeaders ? `${request.responseHeaders?.length ?? 0} res headers` : '',
          ]
            .filter(Boolean)
            .join(' | ');
          return `- ${request.method} ${request.url} -> ${status}${extra ? ` (${extra})` : ''}`;
        })
      : ['- No Chrome debugger network snapshot captured.'];
    const actionTimelineEntries = buildActionTimeline(normalizedClip);
    const actionTimeline = actionTimelineEntries.length
      ? actionTimelineEntries.map((entry) => `- [${entry.tone.toUpperCase()}] ${entry.label}: ${entry.detail}`)
      : ['- No bounded action timeline could be derived for this clip.'];

    return [
      `# Clip ${index + 1}: ${normalizedClip.title}`,
      '',
      ...details,
      '',
      section('Selected Text', [selectedText]),
      section(
        'Headings',
        normalizedClip.domSummary.headings.length ? normalizedClip.domSummary.headings.map((item) => `- ${item}`) : ['- None captured'],
      ),
      section(
        'Buttons',
        normalizedClip.domSummary.buttons.length ? normalizedClip.domSummary.buttons.map((item) => `- ${item}`) : ['- None captured'],
      ),
      section(
        'Fields',
        normalizedClip.domSummary.fields.length ? normalizedClip.domSummary.fields.map((item) => `- ${item}`) : ['- None captured'],
      ),
      section('Runtime Summary', runtimeSummary),
      section('Recent Runtime Events', runtimeEvents),
      section('Recent Network Requests', networkRequests),
      section('Visible Page Summary', visiblePageSummary),
      section('Chrome Debugger Summary', chromeDebuggerSummary),
      section('Chrome Debugger Logs', chromeDebuggerLogs),
      section('Chrome Debugger Network', chromeDebuggerNetwork),
      section('Action Timeline', actionTimeline),
      section('Note', [note]),
    ];
  });

  return [
    '# LLM Clip Session',
    '',
    `- Session created: ${session.createdAt}`,
    `- Last updated: ${session.updatedAt}`,
    `- Clip count: ${session.clips.length}`,
    '',
    ...blocks,
  ].join('\n');
}
