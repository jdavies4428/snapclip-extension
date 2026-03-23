import type { ClipSession } from '../types/session';

function section(title: string, lines: string[]): string {
  return [`## ${title}`, '', ...lines, ''].join('\n');
}

export function createClipSessionMarkdown(session: ClipSession): string {
  const blocks = session.clips.flatMap((clip, index) => {
    const details = [
      `- Mode: ${clip.clipMode}`,
      `- Captured: ${clip.createdAt}`,
      `- URL: ${clip.page.url}`,
      `- Viewport: ${clip.page.viewport.width} x ${clip.page.viewport.height} @ ${clip.page.viewport.dpr}x`,
      `- Region: x=${clip.crop.x}, y=${clip.crop.y}, width=${clip.crop.width}, height=${clip.crop.height}`,
      `- Image size: ${clip.imageWidth} x ${clip.imageHeight}`,
      `- Annotation count: ${clip.annotations.length}`,
    ];

    const selectedText = clip.domSummary.selectedText?.trim() || 'No selected text captured.';
    const note = clip.note.trim() || 'No note added.';
    const runtimeSummary = clip.runtimeContext
      ? [
          `- Installed: ${clip.runtimeContext.summary.installedAt}`,
          `- Last seen: ${clip.runtimeContext.summary.lastSeenAt}`,
          `- Event count: ${clip.runtimeContext.summary.eventCount}`,
          `- Errors: ${clip.runtimeContext.summary.errorCount}`,
          `- Warnings: ${clip.runtimeContext.summary.warningCount}`,
        ]
      : ['- Runtime context was not captured for this clip.'];
    const runtimeEvents = clip.runtimeContext?.events.length
      ? clip.runtimeContext.events.map(
          (event) => `- [${event.level.toUpperCase()}] ${event.type}: ${event.message}`,
        )
      : ['- No recent runtime events captured.'];
    const networkRequests = clip.runtimeContext?.network.length
      ? clip.runtimeContext.network.map((request) => {
          const status = request.status === null ? 'no-status' : String(request.status);
          const error = request.error ? ` (${request.error})` : '';
          return `- [${request.classification.toUpperCase()}] ${request.method} ${request.url} -> ${status} in ${request.durationMs}ms${error}`;
        })
      : ['- No failed or slow requests captured.'];
    const visiblePageSummary = clip.runtimeContext?.domSummary
      ? [
          `- Path: ${clip.runtimeContext.domSummary.path}`,
          ...clip.runtimeContext.domSummary.headingTexts.map((item) => `- Heading: ${item}`),
          ...clip.runtimeContext.domSummary.buttonTexts.map((item) => `- Button: ${item}`),
          ...clip.runtimeContext.domSummary.inputLabels.map((item) => `- Field: ${item}`),
        ]
      : ['- No visible page summary captured.'];
    const chromeDebuggerSummary = clip.runtimeContext?.chromeDebugger
      ? [
          `- Captured at: ${clip.runtimeContext.chromeDebugger.capturedAt}`,
          `- Status: ${clip.runtimeContext.chromeDebugger.attachError || 'Captured'}`,
          `- Current URL: ${clip.runtimeContext.chromeDebugger.currentUrl}`,
          `- Current title: ${clip.runtimeContext.chromeDebugger.currentTitle}`,
          `- Frame count: ${clip.runtimeContext.chromeDebugger.frameCount}`,
          `- DOM nodes: ${clip.runtimeContext.chromeDebugger.performance.nodes ?? 'n/a'}`,
          `- JS heap used: ${clip.runtimeContext.chromeDebugger.performance.jsHeapUsedSize ?? 'n/a'}`,
          `- Chrome logs: ${clip.runtimeContext.chromeDebugger.logs.length}`,
          `- Chrome requests: ${clip.runtimeContext.chromeDebugger.network.length}`,
        ]
      : ['- No Chrome debugger snapshot captured.'];
    const chromeDebuggerLogs = clip.runtimeContext?.chromeDebugger?.logs.length
      ? clip.runtimeContext.chromeDebugger.logs.map(
          (entry) => `- [${entry.level.toUpperCase()}] ${entry.source}: ${entry.text}`,
        )
      : ['- No Chrome debugger logs captured.'];
    const chromeDebuggerNetwork = clip.runtimeContext?.chromeDebugger?.network.length
      ? clip.runtimeContext.chromeDebugger.network.map((request) => {
          const status = request.status === null || typeof request.status === 'undefined' ? 'ERR' : String(request.status);
          const extra = [request.mimeType, request.failedReason, request.blockedReason].filter(Boolean).join(' | ');
          return `- ${request.method} ${request.url} -> ${status}${extra ? ` (${extra})` : ''}`;
        })
      : ['- No Chrome debugger network snapshot captured.'];

    return [
      `# Clip ${index + 1}: ${clip.title}`,
      '',
      ...details,
      '',
      section('Selected Text', [selectedText]),
      section('Headings', clip.domSummary.headings.length ? clip.domSummary.headings.map((item) => `- ${item}`) : ['- None captured']),
      section('Buttons', clip.domSummary.buttons.length ? clip.domSummary.buttons.map((item) => `- ${item}`) : ['- None captured']),
      section('Fields', clip.domSummary.fields.length ? clip.domSummary.fields.map((item) => `- ${item}`) : ['- None captured']),
      section('Runtime Summary', runtimeSummary),
      section('Recent Runtime Events', runtimeEvents),
      section('Recent Network Requests', networkRequests),
      section('Visible Page Summary', visiblePageSummary),
      section('Chrome Debugger Summary', chromeDebuggerSummary),
      section('Chrome Debugger Logs', chromeDebuggerLogs),
      section('Chrome Debugger Network', chromeDebuggerNetwork),
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
