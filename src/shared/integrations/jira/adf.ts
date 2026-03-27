import type { ClipContext } from '../context';

type AdfNode = Record<string, unknown>;

function paragraph(text: string): AdfNode {
  return {
    type: 'paragraph',
    content: text
      ? [
          {
            type: 'text',
            text,
          },
        ]
      : [],
  };
}

function heading(text: string): AdfNode {
  return {
    type: 'heading',
    attrs: {
      level: 3,
    },
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

function bulletList(items: string[]): AdfNode {
  return {
    type: 'bulletList',
    content: items.map((item) => ({
      type: 'listItem',
      content: [paragraph(item)],
    })),
  };
}

export function buildAdfDocument(context: ClipContext) {
  const content: AdfNode[] = [
    heading(context.title),
    paragraph(context.note || 'No additional note provided.'),
    heading('Page'),
    paragraph(`${context.pageTitle}\n${context.pageUrl}`),
    heading('Capture'),
    paragraph(`${context.clipMode} · ${context.viewport}`),
  ];

  if (context.consoleErrors.length) {
    content.push(heading('Console errors'));
    content.push(bulletList(context.consoleErrors));
  }

  if (context.networkFailures.length) {
    content.push(heading('Network failures'));
    content.push(bulletList(context.networkFailures));
  }

  content.push(heading('Attribution'));
  content.push(paragraph(context.attribution));

  return {
    type: 'doc',
    version: 1,
    content,
  };
}
