import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBridgeServer } from '../server.js';

function createBaseTask(workspaceId, overrides = {}) {
  return {
    workspaceId,
    sessionId: null,
    target: 'export_only',
    intent: 'fix',
    payload: {
      title: 'Button alignment issue',
      comment: 'CTA looks clipped on hover.',
      mimeType: 'image/png',
      imageBase64: Buffer.from('image').toString('base64'),
      annotations: [],
      artifacts: {
        screenshotFileName: 'screenshot.png',
        screenshotBase64: Buffer.from('screenshot').toString('base64'),
        annotatedFileName: 'annotated.png',
        annotatedBase64: Buffer.from('annotated').toString('base64'),
        context: { url: 'https://example.com', bug: 'hover-clipping' },
        annotations: { clips: [] },
        promptClaude: '# Claude prompt',
        promptCodex: '# Codex prompt',
      },
    },
    ...overrides,
  };
}

async function startTestBridge(options = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapclip-bridge-'));
  const claudeStateRoot = options.claudeStateRoot ?? (await mkdtemp(join(tmpdir(), 'snapclip-claude-state-')));
  const claudeProjectsRoot = options.claudeProjectsRoot ?? (await mkdtemp(join(tmpdir(), 'snapclip-claude-projects-')));
  const codexStateRoot = options.codexStateRoot ?? (await mkdtemp(join(tmpdir(), 'snapclip-codex-state-')));
  const bridge = createBridgeServer({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    cwd: workspaceRoot,
    env: {},
    claudeStateRoot,
    codexStateRoot,
    claudeProjectsRoot,
    claudeRunner: async () => ({ stdout: 'submitted', stderr: '', code: 0 }),
    ...options,
  });

  await bridge.listen();
  const address = bridge.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return { bridge, workspaceRoot, baseUrl, claudeProjectsRoot, claudeStateRoot, codexStateRoot };
}

async function seedCodexThreadsDatabase(codexStateRoot, rows) {
  const databasePath = join(codexStateRoot, 'state_5.sqlite');
  const statements = [
    `CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0
    );`,
    ...rows.map((row) =>
      [
        'INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, archived)',
        `VALUES ('${row.id}', '${row.rolloutPath ?? ''}', ${row.createdAt}, ${row.updatedAt}, '${row.source}', 'openai', '${row.cwd}', '${row.title}', 'danger-full-access', 'never', ${row.archived ?? 0});`,
      ].join(' '),
    ),
  ];

  execFileSync('sqlite3', [databasePath, statements.join('\n')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function bridgeFetch(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-SnapClip-Token': 'test-token',
      ...(init.headers ?? {}),
    },
  });

  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function waitForTaskStatus(baseUrl, taskId, expectedStatus, attempts = 25) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const task = await bridgeFetch(baseUrl, `/tasks/${taskId}`);
    if (task.payload.status === expectedStatus) {
      return task;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const finalTask = await bridgeFetch(baseUrl, `/tasks/${taskId}`);
  assert.equal(finalTask.payload.status, expectedStatus);
  return finalTask;
}

test('health is public and workspace discovery exposes the configured workspace', async (t) => {
  const { bridge, workspaceRoot, baseUrl } = await startTestBridge();
  t.after(async () => {
    await bridge.close();
  });

  const healthResponse = await fetch(`${baseUrl}/health`);
  const healthPayload = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(healthPayload.ok, true);
  assert.equal(healthPayload.service, 'snapclip-bridge');
  assert.equal(healthPayload.companion.host, '127.0.0.1');
  assert.equal(healthPayload.companion.workspaceCount, 1);
  assert.equal(typeof healthPayload.claude.cliAvailable, 'boolean');
  assert.equal(Array.isArray(healthPayload.claude.installedEvents), true);

  const workspaces = await bridgeFetch(baseUrl, '/workspaces');
  assert.equal(workspaces.response.status, 200);
  assert.equal(workspaces.payload.workspaces.length, 1);
  assert.equal(workspaces.payload.workspaces[0].path, workspaceRoot);
});

test('hook config and install endpoints expose authenticated Claude hook settings', async (t) => {
  const { bridge, workspaceRoot, baseUrl } = await startTestBridge();
  t.after(async () => {
    await bridge.close();
  });

  const configResponse = await bridgeFetch(baseUrl, '/claude/hooks/config');
  assert.equal(configResponse.response.status, 200);
  assert.equal(
    configResponse.payload.hookConfig.hooks.PermissionRequest[0].hooks[0].url,
    `${baseUrl}/hooks/permission-request`,
  );

  const settingsPath = join(workspaceRoot, '.claude', 'settings.local.json');
  const installResponse = await bridgeFetch(baseUrl, '/claude/hooks/install', {
    method: 'POST',
    body: JSON.stringify({ settingsPath }),
  });

  assert.equal(installResponse.response.status, 200);
  const parsedSettings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(
    parsedSettings.hooks.PermissionRequest[0].hooks[0].url,
    `${baseUrl}/hooks/permission-request`,
  );
});

test('active sessions are listed across workspaces without requiring workspace selection', async (t) => {
  const { bridge, baseUrl } = await startTestBridge();
  t.after(async () => {
    await bridge.close();
  });

  await bridgeFetch(baseUrl, '/hooks/session-start', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'session-live-1',
      cwd: bridge.config.cwd,
      hook_event_name: 'SessionStart',
      source: 'test',
    }),
  });

  const active = await bridgeFetch(baseUrl, '/sessions/active');
  assert.equal(active.response.status, 200);
  assert.equal(active.payload.sessions.length, 1);
  assert.equal(active.payload.sessions[0].id, 'session-live-1');
  assert.equal(active.payload.sessions[0].workspaceId, bridge.registry.listWorkspaces()[0].id);
  assert.equal(typeof active.payload.sessions[0].workspaceName, 'string');
});

test('active sessions include live Cursor-backed Claude sessions from local session state', async (t) => {
  const claudeStateRoot = await mkdtemp(join(tmpdir(), 'snapclip-claude-state-'));
  const cursorWorkspace = await mkdtemp(join(tmpdir(), 'snapclip-cursor-workspace-'));
  await mkdir(join(claudeStateRoot, 'sessions'), { recursive: true });
  await mkdir(join(claudeStateRoot, 'ide'), { recursive: true });
  await writeFile(
    join(claudeStateRoot, 'sessions', '40287.json'),
    JSON.stringify({
      pid: process.pid,
      sessionId: 'cursor-session-1',
      cwd: cursorWorkspace,
      startedAt: Date.now(),
      kind: 'interactive',
      entrypoint: 'claude-vscode',
    }),
  );
  await writeFile(
    join(claudeStateRoot, 'ide', '30304.lock'),
    JSON.stringify({
      pid: 623,
      workspaceFolders: [cursorWorkspace],
      ideName: 'Cursor',
      transport: 'ws',
      authToken: 'cursor-auth-token',
    }),
  );

  const { bridge, baseUrl } = await startTestBridge({ claudeStateRoot });
  t.after(async () => {
    await bridge.close();
  });

  const active = await bridgeFetch(baseUrl, '/sessions/active');
  assert.equal(active.response.status, 200);
  assert.equal(active.payload.sessions.some((session) => session.id === 'cursor-session-1'), true);

  const cursorSession = active.payload.sessions.find((session) => session.id === 'cursor-session-1');
  assert.equal(cursorSession.surface, 'cursor');
  assert.equal(cursorSession.cwd, cursorWorkspace);
  assert.equal(typeof cursorSession.workspaceName, 'string');
});

test('active sessions include recent Codex threads from the local Codex state database', async (t) => {
  const codexStateRoot = await mkdtemp(join(tmpdir(), 'snapclip-codex-state-'));
  const codexWorkspace = await mkdtemp(join(tmpdir(), 'snapclip-codex-workspace-'));
  const nowSeconds = Math.floor(Date.now() / 1000);
  await seedCodexThreadsDatabase(codexStateRoot, [
    {
      id: 'codex-thread-1',
      cwd: codexWorkspace,
      title: 'Fix clipped CTA',
      source: 'vscode',
      createdAt: nowSeconds - 60,
      updatedAt: nowSeconds - 15,
      rolloutPath: 'sessions/2026/03/26/codex-thread-1.jsonl',
    },
    {
      id: 'codex-thread-old',
      cwd: codexWorkspace,
      title: 'Old archived work',
      source: 'vscode',
      createdAt: nowSeconds - 10 * 60 * 60,
      updatedAt: nowSeconds - 9 * 60 * 60,
      rolloutPath: 'sessions/2026/03/26/codex-thread-old.jsonl',
    },
  ]);

  const { bridge, baseUrl } = await startTestBridge({ codexStateRoot });
  t.after(async () => {
    await bridge.close();
  });

  const active = await bridgeFetch(baseUrl, '/sessions/active');
  assert.equal(active.response.status, 200);
  assert.equal(active.payload.sessions.some((session) => session.id === 'codex-thread-1'), true);
  assert.equal(active.payload.sessions.some((session) => session.id === 'codex-thread-old'), false);

  const codexSession = active.payload.sessions.find((session) => session.id === 'codex-thread-1');
  assert.equal(codexSession.target, 'codex');
  assert.equal(codexSession.surface, 'codex');
  assert.equal(codexSession.cwd, codexWorkspace);
  assert.equal(typeof codexSession.workspaceName, 'string');
});

test('creating an export task writes a deterministic bundle and completes immediately', async (t) => {
  const { bridge, baseUrl } = await startTestBridge();
  t.after(async () => {
    await bridge.close();
  });

  const workspaces = await bridgeFetch(baseUrl, '/workspaces');
  const workspaceId = workspaces.payload.workspaces[0].id;

  const created = await bridgeFetch(baseUrl, '/tasks', {
    method: 'POST',
    body: JSON.stringify(createBaseTask(workspaceId)),
  });

  assert.equal(created.response.status, 200);
  assert.equal(created.payload.status, 'accepted');
  assert.equal(created.payload.delivery.state, 'bundle_created');

  const taskDetails = await waitForTaskStatus(baseUrl, created.payload.taskId, 'completed');
  assert.equal(taskDetails.response.status, 200);

  const bundlePath = created.payload.bundlePath;
  const prompt = await readFile(join(bundlePath, 'prompt.md'), 'utf8');
  const context = await readFile(join(bundlePath, 'context.json'), 'utf8');
  const screenshotStats = await stat(join(bundlePath, 'screenshot.png'));

  assert.equal(prompt.trim(), '# Claude prompt');
  assert.match(context, /hover-clipping/);
  assert.ok(screenshotStats.size > 0);
});

test('image-only session bundles write all clip images and omit shared packet files', async (t) => {
  const { bridge, baseUrl } = await startTestBridge();
  t.after(async () => {
    await bridge.close();
  });

  const workspaces = await bridgeFetch(baseUrl, '/workspaces');
  const workspaceId = workspaces.payload.workspaces[0].id;
  const created = await bridgeFetch(baseUrl, '/tasks', {
    method: 'POST',
    body: JSON.stringify(
      createBaseTask(workspaceId, {
        target: 'claude',
        sessionId: 'claude-session-1',
        packageMode: 'image',
        payload: {
          ...createBaseTask(workspaceId).payload,
          artifacts: {
            ...createBaseTask(workspaceId).payload.artifacts,
            context: null,
            annotations: null,
            clipImages: [
              {
                clipId: 'clip-1',
                title: 'First clip',
                note: 'Baseline before the hover state breaks.',
                screenshotFileName: 'clips/01-clip-1-raw.png',
                screenshotBase64: Buffer.from('clip-1-raw').toString('base64'),
                annotatedFileName: 'clips/01-clip-1-annotated.png',
                annotatedBase64: Buffer.from('clip-1-annotated').toString('base64'),
              },
              {
                clipId: 'clip-2',
                title: 'Second clip',
                note: 'Hover state is broken in this image.',
                screenshotFileName: 'clips/02-clip-2-raw.png',
                screenshotBase64: Buffer.from('clip-2-raw').toString('base64'),
                annotatedFileName: 'clips/02-clip-2-annotated.png',
                annotatedBase64: Buffer.from('clip-2-annotated').toString('base64'),
              },
            ],
            clipsManifest: {
              orderedClipIds: ['clip-1', 'clip-2'],
              clips: [
                {
                  clipId: 'clip-1',
                  title: 'First clip',
                  note: 'Baseline before the hover state breaks.',
                  screenshotFileName: 'clips/01-clip-1-raw.png',
                  annotatedFileName: 'clips/01-clip-1-annotated.png',
                },
                {
                  clipId: 'clip-2',
                  title: 'Second clip',
                  note: 'Hover state is broken in this image.',
                  screenshotFileName: 'clips/02-clip-2-raw.png',
                  annotatedFileName: 'clips/02-clip-2-annotated.png',
                },
              ],
            },
          },
        },
      }),
    ),
  });

  assert.equal(created.response.status, 200);

  const bundlePath = created.payload.bundlePath;
  const firstClipStats = await stat(join(bundlePath, 'clips/01-clip-1-raw.png'));
  const secondClipStats = await stat(join(bundlePath, 'clips/02-clip-2-annotated.png'));
  const clipsManifest = JSON.parse(await readFile(join(bundlePath, 'clips_manifest.json'), 'utf8'));
  assert.ok(firstClipStats.size > 0);
  assert.ok(secondClipStats.size > 0);
  assert.deepEqual(clipsManifest.orderedClipIds, ['clip-1', 'clip-2']);
  assert.equal(clipsManifest.clips[0].note, 'Baseline before the hover state breaks.');
  assert.equal(clipsManifest.clips[1].annotatedFileName, 'clips/02-clip-2-annotated.png');

  await assert.rejects(() => stat(join(bundlePath, 'context.json')));
  await assert.rejects(() => stat(join(bundlePath, 'annotations.json')));
});

test('claude task delivery is queued and can be polled to completion', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapclip-bridge-'));
  const claudeStateRoot = await mkdtemp(join(tmpdir(), 'snapclip-claude-state-'));
  const codexStateRoot = await mkdtemp(join(tmpdir(), 'snapclip-codex-state-'));
  const capturedCalls = [];
  const bridge = createBridgeServer({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    cwd: workspaceRoot,
    env: {},
    claudeStateRoot,
    codexStateRoot,
    claudeRunner: async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      capturedCalls.push(input);
      return { stdout: 'resume submitted', stderr: '', code: 0 };
    },
  });

  await bridge.listen();
  const address = bridge.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await bridge.close();
  });

  const workspaces = await bridgeFetch(baseUrl, '/workspaces');
  const workspaceId = workspaces.payload.workspaces[0].id;

  const created = await bridgeFetch(baseUrl, '/tasks', {
    method: 'POST',
    body: JSON.stringify(
      createBaseTask(workspaceId, {
        target: 'claude',
        sessionId: 'claude-session-1',
      }),
    ),
  });

  assert.equal(created.response.status, 200);
  assert.equal(created.payload.status, 'accepted');
  assert.equal(created.payload.delivery.state, 'queued');

  const taskDetails = await waitForTaskStatus(baseUrl, created.payload.taskId, 'completed');
  assert.equal(taskDetails.payload.delivery.state, 'delivered');
  assert.equal(taskDetails.payload.delivery.target, 'claude_session');
  assert.equal(capturedCalls.length, 1);
  assert.equal(capturedCalls[0].sessionId, 'claude-session-1');
  assert.equal(capturedCalls[0].cwd, workspaceRoot);
  assert.match(capturedCalls[0].prompt, /prompt-claude\.md/);
});

test('codex task delivery is queued and resumes the target session with both images', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapclip-bridge-'));
  const claudeStateRoot = await mkdtemp(join(tmpdir(), 'snapclip-claude-state-'));
  const codexStateRoot = await mkdtemp(join(tmpdir(), 'snapclip-codex-state-'));
  const capturedCalls = [];
  const bridge = createBridgeServer({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    cwd: workspaceRoot,
    env: {},
    claudeStateRoot,
    codexStateRoot,
    codexRunner: async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      capturedCalls.push(input);
      return { stdout: 'resume submitted', stderr: '', code: 0 };
    },
  });

  await bridge.listen();
  const address = bridge.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await bridge.close();
  });

  const workspaces = await bridgeFetch(baseUrl, '/workspaces');
  const workspaceId = workspaces.payload.workspaces[0].id;

  const created = await bridgeFetch(baseUrl, '/tasks', {
    method: 'POST',
    body: JSON.stringify(
      createBaseTask(workspaceId, {
        target: 'codex',
        sessionId: 'codex-thread-1',
      }),
    ),
  });

  assert.equal(created.response.status, 200);
  assert.equal(created.payload.status, 'accepted');
  assert.equal(created.payload.delivery.state, 'queued');

  const taskDetails = await waitForTaskStatus(baseUrl, created.payload.taskId, 'completed');
  assert.equal(taskDetails.payload.delivery.state, 'delivered');
  assert.equal(taskDetails.payload.delivery.target, 'codex_session');
  assert.equal(capturedCalls.length, 1);
  assert.equal(capturedCalls[0].sessionId, 'codex-thread-1');
  assert.equal(capturedCalls[0].cwd, workspaceRoot);
  assert.deepEqual(capturedCalls[0].imagePaths, ['screenshot.png', 'annotated.png']);
  assert.match(capturedCalls[0].prompt, /prompt-codex\.md/);
});

test('permission requests can be discovered and resolved through the public approval API', async (t) => {
  const { bridge, baseUrl } = await startTestBridge();
  t.after(async () => {
    await bridge.close();
  });

  const permissionRequestPromise = bridgeFetch(baseUrl, '/hooks/permission-request', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'session-live-1',
      cwd: bridge.config.cwd,
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm run lint' },
      permission_suggestions: [],
    }),
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const workspaceId = bridge.registry.listWorkspaces()[0].id;
  const approvals = await bridgeFetch(
    baseUrl,
    `/approvals?workspaceId=${encodeURIComponent(workspaceId)}&status=pending`,
  );
  assert.equal(approvals.response.status, 200);
  assert.equal(approvals.payload.approvals.length, 1);
  assert.equal(approvals.payload.approvals[0].toolName, 'Bash');
  assert.deepEqual(approvals.payload.approvals[0].toolInput, { command: 'npm run lint' });

  const approvalResponse = await bridgeFetch(baseUrl, `/approvals/${approvals.payload.approvals[0].id}/decision`, {
    method: 'POST',
    body: JSON.stringify({
      behavior: 'allow',
      updatedInput: { command: 'npm run lint -- --fix' },
    }),
  });

  assert.equal(approvalResponse.response.status, 200);

  const hookResponse = await permissionRequestPromise;
  assert.equal(hookResponse.response.status, 200);
  assert.deepEqual(hookResponse.payload, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
        updatedInput: { command: 'npm run lint -- --fix' },
      },
    },
  });
});

test('session-end clears pending approvals and denies the waiting hook', async (t) => {
  const { bridge, baseUrl } = await startTestBridge();
  t.after(async () => {
    await bridge.close();
  });

  const permissionRequestPromise = bridgeFetch(baseUrl, '/hooks/permission-request', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'session-live-2',
      cwd: bridge.config.cwd,
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      permission_suggestions: [],
    }),
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const workspaceId = bridge.registry.listWorkspaces()[0].id;
  const sessionEnd = await bridgeFetch(baseUrl, '/hooks/session-end', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'session-live-2',
      cwd: bridge.config.cwd,
      hook_event_name: 'SessionEnd',
    }),
  });

  assert.equal(sessionEnd.response.status, 200);

  const hookResponse = await permissionRequestPromise;
  assert.equal(hookResponse.response.status, 200);
  assert.equal(hookResponse.payload.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(hookResponse.payload.hookSpecificOutput.decision.message, /session ended/i);

  const approvals = await bridgeFetch(
    baseUrl,
    `/approvals?workspaceId=${encodeURIComponent(workspaceId)}&status=pending`,
  );
  assert.equal(approvals.payload.approvals.length, 0);

  const sessions = await bridgeFetch(baseUrl, `/sessions?workspaceId=${encodeURIComponent(workspaceId)}`);
  assert.equal(sessions.payload.sessions[0].pendingApprovalCount, 0);
  assert.equal(sessions.payload.sessions[0].status, 'ended');
});

test('malformed task payloads return a validation error instead of a server error', async (t) => {
  const { bridge, baseUrl } = await startTestBridge();
  t.after(async () => {
    await bridge.close();
  });

  const workspaces = await bridgeFetch(baseUrl, '/workspaces');
  const workspaceId = workspaces.payload.workspaces[0].id;
  const malformed = createBaseTask(workspaceId);
  delete malformed.payload.artifacts.screenshotBase64;

  const response = await bridgeFetch(baseUrl, '/tasks', {
    method: 'POST',
    body: JSON.stringify(malformed),
  });

  assert.equal(response.response.status, 400);
  assert.match(response.payload.error, /screenshotBase64/);
});
