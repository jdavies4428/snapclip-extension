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
  const clipImages = Array.isArray(payload.artifacts.clipImages) ? payload.artifacts.clipImages : [];
  const clipsManifest = payload.artifacts.clipsManifest && typeof payload.artifacts.clipsManifest === 'object'
    ? payload.artifacts.clipsManifest
    : null;
  const hasPacketFiles = Boolean(payload.artifacts.context && payload.artifacts.annotations);

  const manifest = {
    bundleVersion: 1,
    target,
    packageMode: taskRequest.packageMode ?? 'packet',
    intent: taskRequest.intent,
    workspaceId: taskRequest.workspaceId,
    sessionId: taskRequest.sessionId,
    title: payload.title,
    comment: payload.comment,
    files: [
      'screenshot.png',
      'annotated.png',
      ...clipImages.flatMap((entry) => [entry.screenshotFileName, entry.annotatedFileName]),
      ...(clipsManifest ? ['clips_manifest.json'] : []),
      ...(hasPacketFiles ? ['context.json', 'annotations.json'] : []),
      'prompt.md',
    ],
  };

  const files = {
    'screenshot.png': decodeBase64(payload.artifacts.screenshotBase64),
    'annotated.png': decodeBase64(payload.artifacts.annotatedBase64),
    'prompt.md': `${defaultPrompt.trim()}\n`,
    'prompt-claude.md': `${payload.artifacts.promptClaude.trim()}\n`,
    'prompt-codex.md': `${payload.artifacts.promptCodex.trim()}\n`,
    'task.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'request.json': `${stableStringify(taskRequest)}\n`,
  };

  clipImages.forEach((entry) => {
    files[entry.screenshotFileName] = decodeBase64(entry.screenshotBase64);
    files[entry.annotatedFileName] = decodeBase64(entry.annotatedBase64);
  });

  if (clipsManifest) {
    files['clips_manifest.json'] = `${JSON.stringify(clipsManifest, null, 2)}\n`;
  }

  if (hasPacketFiles) {
    files['context.json'] = `${JSON.stringify(payload.artifacts.context, null, 2)}\n`;
    files['annotations.json'] = `${JSON.stringify(payload.artifacts.annotations, null, 2)}\n`;
  }

  return files;
}
