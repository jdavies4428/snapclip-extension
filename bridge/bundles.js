import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { stableStringify } from './utils.js';

function decodeBase64(value) {
  return Buffer.from(value, 'base64');
}

export async function writeTaskBundle({ workspacePath, taskRequest, bundleSlug, clock = () => new Date() }) {
  const dateBucket = clock().toISOString().slice(0, 10);
  const bundlePath = join(workspacePath, 'snapclip-local', 'sessions', dateBucket, bundleSlug);
  const files = buildBundleFiles(taskRequest);

  await mkdir(bundlePath, { recursive: true });

  await Promise.all(
    Object.entries(files).map(async ([relativePath, value]) => {
      const fullPath = join(bundlePath, relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, value);
    }),
  );

  return bundlePath;
}

function buildBundleFiles(taskRequest) {
  const { payload, target } = taskRequest;
  const defaultPrompt = target === 'codex' ? payload.artifacts.promptCodex : payload.artifacts.promptClaude;

  const manifest = {
    bundleVersion: 1,
    target,
    intent: taskRequest.intent,
    workspaceId: taskRequest.workspaceId,
    sessionId: taskRequest.sessionId,
    title: payload.title,
    comment: payload.comment,
    files: ['screenshot.png', 'annotated.png', 'context.json', 'annotations.json', 'prompt.md'],
  };

  return {
    'screenshot.png': decodeBase64(payload.artifacts.screenshotBase64),
    'annotated.png': decodeBase64(payload.artifacts.annotatedBase64),
    'context.json': `${JSON.stringify(payload.artifacts.context, null, 2)}\n`,
    'annotations.json': `${JSON.stringify(payload.artifacts.annotations, null, 2)}\n`,
    'prompt.md': `${defaultPrompt.trim()}\n`,
    'prompt-claude.md': `${payload.artifacts.promptClaude.trim()}\n`,
    'prompt-codex.md': `${payload.artifacts.promptCodex.trim()}\n`,
    'task.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'request.json': `${stableStringify(taskRequest)}\n`,
  };
}
