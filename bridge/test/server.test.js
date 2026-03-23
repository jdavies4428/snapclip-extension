import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
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
  const bridge = createBridgeServer({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    cwd: workspaceRoot,
    claudeRunner: async () => ({ stdout: 'submitted', stderr: '', code: 0 }),
    ...options,
  });

  await bridge.listen();
  const address = bridge.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return { bridge, workspaceRoot, baseUrl };
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

test('claude task delivery is queued and can be polled to completion', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapclip-bridge-'));
  const capturedCalls = [];
  const bridge = createBridgeServer({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    cwd: workspaceRoot,
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
