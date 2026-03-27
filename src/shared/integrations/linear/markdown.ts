import type { ClipContext } from '../context';

export function buildMarkdownBody(context: ClipContext, imageDataUrl: string): string {
  const sections = [
    context.note || 'No additional note provided.',
    '',
    `![${context.title}](${imageDataUrl})`,
    '',
    `**Page:** ${context.pageTitle}`,
    '',
    `**URL:** ${context.pageUrl}`,
    '',
    `**Capture:** ${context.clipMode} · ${context.viewport}`,
  ];

  if (context.consoleErrors.length) {
    sections.push('', '**Console errors**');
    sections.push(...context.consoleErrors.map((item) => `- ${item}`));
  }

  if (context.networkFailures.length) {
    sections.push('', '**Network failures**');
    sections.push(...context.networkFailures.map((item) => `- ${item}`));
  }

  sections.push('', context.attribution);
  return sections.join('\n');
}
