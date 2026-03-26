import http from 'node:http';
import { resolve } from 'node:path';

import { writeTaskBundle } from './bundles.js';
import { runClaudeResume, buildClaudeResumePrompt, probeClaudeCli } from './claude.js';
import { runCodexResume, buildCodexResumePrompt } from './codex.js';
import { resolveBridgeConfig } from './config.js';
import {
  buildClaudeHookConfig,
  inspectClaudeHookConfig,
  getDefaultClaudeSettingsPath,
  installClaudeHookConfig,
} from './hooks.js';
import { BridgeRegistry } from './registry.js';
import { getRequestToken, isObject, readJsonBody, sendJson } from './utils.js';

/*
Request flow
------------
extension -> /tasks ----------> write bundle ----------> optional `claude -r <session> -p <prompt>`
claude   -> /hooks/* ---------> update live session registry
claude   -> /hooks/permission-request --holds open--> /approvals/:id/decision --> hook JSON response
*/

export function createBridgeServer(options = {}) {
  const config = resolveBridgeConfig(options);
  const registry = options.registry ?? new BridgeRegistry(config);
  const claudeRunner = options.claudeRunner ?? runClaudeResume;
  const codexRunner = options.codexRunner ?? runCodexResume;
  const claudeProbe = options.claudeProbe ?? probeClaudeCli;
  const clock = options.clock ?? (() => new Date());
  const taskJobs = new Set();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const pathname = url.pathname;

    try {
      if (request.method === 'GET' && pathname === '/health') {
        const bridgeBaseUrl = buildBridgeBaseUrl(request, config);
        const [claudeStatus, hookStatus] = await Promise.all([
          claudeProbe(),
          inspectClaudeHookConfig({
            cwd: config.cwd,
            baseUrl: bridgeBaseUrl,
            token: config.token,
          }),
        ]);
        const workspaces = registry.listWorkspaces();
        sendJson(response, 200, {
          ok: true,
          service: 'snapclip-bridge',
          now: clock().toISOString(),
          companion: {
            version: options.version ?? process.env.npm_package_version ?? '0.1.0',
            host: config.host,
            port: config.port,
            workspaceCount: workspaces.length,
            liveSessionCount: workspaces.reduce((count, workspace) => count + workspace.sessionCount, 0),
          },
          claude: {
            cliAvailable: Boolean(claudeStatus.cliAvailable),
            cliVersion: claudeStatus.cliVersion ?? null,
            defaultSettingsPath: hookStatus.settingsPath || getDefaultClaudeSettingsPath(config.cwd),
            hookInstalled: hookStatus.hookInstalled,
            installedEvents: hookStatus.installedEvents,
          },
        });
        return;
      }

      if (!isAuthorized(request, config.token)) {
        sendJson(response, 401, { error: 'Unauthorized bridge request.' });
        return;
      }

      if (request.method === 'GET' && pathname === '/workspaces') {
        sendJson(response, 200, { workspaces: registry.listWorkspaces() });
        return;
      }

      if (request.method === 'GET' && pathname === '/sessions') {
        const workspaceId = url.searchParams.get('workspaceId') ?? '';
        if (!workspaceId) {
          sendJson(response, 400, { error: 'workspaceId is required.' });
          return;
        }

        const liveOnly = (url.searchParams.get('view') ?? '').toLowerCase() === 'live';
        sendJson(response, 200, {
          sessions: registry.listSessions(workspaceId, { liveOnly }),
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/sessions/active') {
        sendJson(response, 200, {
          sessions: registry.listActiveSessions(),
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/approvals') {
        sendJson(response, 200, {
          approvals: registry.listApprovals({
            workspaceId: url.searchParams.get('workspaceId') ?? '',
            sessionId: url.searchParams.get('sessionId') ?? '',
            status: url.searchParams.get('status') ?? 'pending',
          }),
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/claude/hooks/config') {
        const hookConfig = buildClaudeHookConfig({
          baseUrl: buildBridgeBaseUrl(request, config),
          token: config.token,
        });

        sendJson(response, 200, {
          settingsPath: getDefaultClaudeSettingsPath(config.cwd),
          installedEvents: Object.keys(hookConfig.hooks),
          hookConfig,
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/claude/hooks/install') {
        const body = await readBridgeJsonBody(request);
        const installRequest = validateHookInstallRequest(body);
        const result = await installClaudeHookConfig({
          cwd: config.cwd,
          settingsPath: installRequest.settingsPath || undefined,
          baseUrl: installRequest.baseUrl || buildBridgeBaseUrl(request, config),
          token: installRequest.token || config.token,
        });

        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && pathname === '/tasks') {
        const body = await readBridgeJsonBody(request);
        const taskRequest = validateTaskRequest(body);
        const workspace = registry.getWorkspace(taskRequest.workspaceId);

        if (!workspace) {
          sendJson(response, 404, { error: 'Workspace was not found.' });
          return;
        }

        const bundleSlug = registry.buildBundleSlug(taskRequest);
        const bundlePath = await writeTaskBundle({
          workspacePath: workspace.path,
          taskRequest,
          bundleSlug,
          clock,
        });

        const task = registry.createTaskRecord({
          workspaceId: workspace.id,
          sessionId: taskRequest.sessionId,
          target: taskRequest.target,
          intent: taskRequest.intent,
          title: taskRequest.payload.title,
          bundlePath,
          bundleSignature: registry.buildDeterministicBundleSignature(taskRequest),
        });

        if (shouldQueueTaskDelivery(taskRequest)) {
          queueTaskDelivery({
            taskJobs,
            registry,
            task,
            taskRequest,
            workspacePath: workspace.path,
            bundlePath,
            claudeRunner,
            codexRunner,
          });

          sendJson(response, 200, {
            taskId: task.id,
            status: 'accepted',
            bundlePath: task.bundlePath,
            delivery: task.delivery,
          });
          return;
        }

        const delivery = await deliverTask({
          taskRequest,
          workspacePath: workspace.path,
          bundlePath,
          claudeRunner,
          codexRunner,
        });

        const updatedTask = registry.updateTask(task.id, delivery);
        sendJson(response, 200, {
          taskId: updatedTask.id,
          status: 'accepted',
          bundlePath: updatedTask.bundlePath,
          delivery: updatedTask.delivery,
        });
        return;
      }

      if (request.method === 'GET' && pathname.startsWith('/tasks/')) {
        const taskId = pathname.slice('/tasks/'.length);
        const task = registry.getTask(taskId);
        if (!task) {
          sendJson(response, 404, { error: 'Task was not found.' });
          return;
        }

        sendJson(response, 200, task);
        return;
      }

      if (request.method === 'POST' && pathname.startsWith('/approvals/')) {
        const suffix = pathname.slice('/approvals/'.length);
        const [approvalId, action] = suffix.split('/');

        if (!approvalId || action !== 'decision') {
          sendJson(response, 404, { error: 'Approval endpoint was not found.' });
          return;
        }

        const body = await readBridgeJsonBody(request);
        const decision = validateApprovalDecision(body);
        const approval = registry.resolveApproval(approvalId, decision);

        if (!approval) {
          sendJson(response, 404, { error: 'Approval request was not found.' });
          return;
        }

        sendJson(response, 200, {
          approvalId,
          status: 'resolved',
          sessionId: approval.sessionId,
        });
        return;
      }

      if (request.method === 'POST' && pathname.startsWith('/hooks/')) {
        const eventName = pathname.slice('/hooks/'.length);
        const body = await readBridgeJsonBody(request);
        const payload = validateHookPayload(body, eventName);

        if (eventName === 'permission-request') {
          const approval = registry.createPendingApproval(payload);
          try {
            const hookResponse = await approval.result;
            sendJson(response, 200, hookResponse);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : 'Permission request approval did not complete successfully.';
            sendJson(response, 200, {
              hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: {
                  behavior: 'deny',
                  message,
                },
              },
            });
          }
          return;
        }

        registry.upsertSession(payload, eventName);
        sendJson(response, 200, {});
        return;
      }

      sendJson(response, 404, { error: 'Route not found.' });
    } catch (error) {
      if (error instanceof BridgeRequestError) {
        sendJson(response, error.statusCode, { error: error.message });
        return;
      }

      const message = error instanceof Error ? error.message : 'Unexpected bridge error.';
      sendJson(response, 500, { error: message });
    }
  });

  return {
    server,
    registry,
    config,
    async listen() {
      await new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(config.port, config.host, () => {
          server.off('error', rejectPromise);
          resolvePromise();
        });
      });

      return server.address();
    },
    async close() {
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error) {
            rejectPromise(error);
            return;
          }
          resolvePromise();
        });
      });

      await Promise.allSettled(Array.from(taskJobs));
    },
  };
}

function buildBridgeBaseUrl(request, config) {
  const host = request?.headers?.host;
  if (typeof host === 'string' && host.trim()) {
    return `http://${host.trim()}`;
  }

  return `http://${config.host}:${config.port}`;
}

async function readBridgeJsonBody(request) {
  try {
    return await readJsonBody(request);
  } catch {
    throw new BridgeRequestError(400, 'Request body must be valid JSON.');
  }
}

function shouldQueueTaskDelivery(taskRequest) {
  return (taskRequest.target === 'claude' || taskRequest.target === 'codex') && Boolean(taskRequest.sessionId);
}

function queueTaskDelivery({ taskJobs, registry, task, taskRequest, workspacePath, bundlePath, claudeRunner, codexRunner }) {
  queueMicrotask(() => {
    const job = (async () => {
      registry.updateTask(task.id, {
        status: 'in_progress',
        delivery: {
          state: 'delivering',
          target: taskRequest.target === 'codex' ? 'codex_session' : 'claude_session',
          sessionId: taskRequest.sessionId,
          mode: taskRequest.target === 'codex' ? 'codex_resume' : 'claude_resume',
          stdout: null,
          error: null,
        },
      });

      const delivery = await deliverTask({
        taskRequest,
        workspacePath,
        bundlePath,
        claudeRunner,
        codexRunner,
      });

      registry.updateTask(task.id, delivery);
    })()
      .catch((error) => {
        registry.updateTask(task.id, {
          status: 'failed',
          delivery: {
            state: 'failed_after_bundle_creation',
            target: taskRequest.target === 'codex' ? 'codex_session' : 'claude_session',
            sessionId: taskRequest.sessionId,
            mode: taskRequest.target === 'codex' ? 'codex_resume' : 'claude_resume',
            stdout: null,
            error: error instanceof Error ? error.message : `${taskRequest.target === 'codex' ? 'Codex' : 'Claude'} delivery failed.`,
          },
        });
      })
      .finally(() => {
        taskJobs.delete(job);
      });

    taskJobs.add(job);
  });
}

async function deliverTask({ taskRequest, workspacePath, bundlePath, claudeRunner, codexRunner }) {
  if (taskRequest.target !== 'claude' && taskRequest.target !== 'codex') {
    return {
      status: 'completed',
      delivery: {
        state: 'bundle_created',
        target: 'bundle_only',
        sessionId: taskRequest.sessionId,
        mode: 'bundle_only',
      },
    };
  }

  if (!taskRequest.sessionId) {
    return {
      status: 'completed',
      delivery: {
        state: 'bundle_created',
        target: taskRequest.target === 'codex' ? 'codex_bundle' : 'bundle_only',
        sessionId: null,
        mode: 'bundle_only',
      },
    };
  }

  try {
    const isCodexTarget = taskRequest.target === 'codex';
    const prompt = isCodexTarget
      ? buildCodexResumePrompt(bundlePath, taskRequest.payload.artifacts.promptCodex, workspacePath)
      : buildClaudeResumePrompt(bundlePath, taskRequest.payload.artifacts.promptClaude, workspacePath);
    const result = await (isCodexTarget ? codexRunner : claudeRunner)({
      sessionId: taskRequest.sessionId,
      prompt,
      cwd: resolve(workspacePath),
      imagePaths: isCodexTarget ? ['screenshot.png', 'annotated.png'] : undefined,
    });

    return {
      status: 'completed',
      delivery: {
        state: 'delivered',
        target: isCodexTarget ? 'codex_session' : 'claude_session',
        sessionId: taskRequest.sessionId,
        mode: isCodexTarget ? 'codex_resume' : 'claude_resume',
        stdout: result.stdout || null,
        error: null,
      },
    };
  } catch (error) {
    return {
      status: 'failed',
      delivery: {
        state: 'failed_after_bundle_creation',
        target: taskRequest.target === 'codex' ? 'codex_session' : 'claude_session',
        sessionId: taskRequest.sessionId,
        mode: taskRequest.target === 'codex' ? 'codex_resume' : 'claude_resume',
        stdout: error?.stdout ?? null,
        error: error instanceof Error ? error.message : `${taskRequest.target === 'codex' ? 'Codex' : 'Claude'} delivery failed.`,
      },
    };
  }
}

function isAuthorized(request, expectedToken) {
  return getRequestToken(request) === expectedToken;
}

function validateTaskRequest(value) {
  if (!isObject(value)) {
    throw new BridgeRequestError(400, 'Task request must be a JSON object.');
  }

  const { workspaceId, sessionId, target, intent, payload } = value;
  if (typeof workspaceId !== 'string' || !workspaceId) {
    throw new BridgeRequestError(400, 'workspaceId is required.');
  }

  if (sessionId !== null && typeof sessionId !== 'string') {
    throw new BridgeRequestError(400, 'sessionId must be a string or null.');
  }

  if (!['claude', 'codex', 'export_only'].includes(target)) {
    throw new BridgeRequestError(400, 'target must be claude, codex, or export_only.');
  }

  if (!['fix', 'plan', 'explain'].includes(intent)) {
    throw new BridgeRequestError(400, 'intent must be fix, plan, or explain.');
  }

  if (value.packageMode !== undefined && !['image', 'packet'].includes(value.packageMode)) {
    throw new BridgeRequestError(400, 'packageMode must be image or packet.');
  }

  if (!isObject(payload)) {
    throw new BridgeRequestError(400, 'payload is required.');
  }

  if (typeof payload.title !== 'string') {
    throw new BridgeRequestError(400, 'payload.title must be a string.');
  }

  if (typeof payload.comment !== 'string') {
    throw new BridgeRequestError(400, 'payload.comment must be a string.');
  }

  if (payload.mimeType !== 'image/png') {
    throw new BridgeRequestError(400, 'payload.mimeType must be image/png.');
  }

  if (!Array.isArray(payload.annotations)) {
    throw new BridgeRequestError(400, 'payload.annotations must be an array.');
  }

  if (!isObject(payload.artifacts)) {
    throw new BridgeRequestError(400, 'payload.artifacts is required.');
  }

  validateRequiredString(payload.artifacts.screenshotBase64, 'payload.artifacts.screenshotBase64');
  validateRequiredString(payload.artifacts.annotatedBase64, 'payload.artifacts.annotatedBase64');
  validateRequiredString(payload.artifacts.promptClaude, 'payload.artifacts.promptClaude');
  validateRequiredString(payload.artifacts.promptCodex, 'payload.artifacts.promptCodex');

  if (payload.artifacts.context !== undefined && payload.artifacts.context !== null && !isObject(payload.artifacts.context)) {
    throw new BridgeRequestError(400, 'payload.artifacts.context must be a JSON object when provided.');
  }

  if (
    payload.artifacts.annotations !== undefined &&
    payload.artifacts.annotations !== null &&
    !isObject(payload.artifacts.annotations)
  ) {
    throw new BridgeRequestError(400, 'payload.artifacts.annotations must be a JSON object when provided.');
  }

  if (payload.artifacts.clipImages !== undefined) {
    if (!Array.isArray(payload.artifacts.clipImages)) {
      throw new BridgeRequestError(400, 'payload.artifacts.clipImages must be an array when provided.');
    }

    payload.artifacts.clipImages.forEach((entry, index) => {
      if (!isObject(entry)) {
        throw new BridgeRequestError(400, `payload.artifacts.clipImages[${index}] must be an object.`);
      }

      validateRequiredString(entry.clipId, `payload.artifacts.clipImages[${index}].clipId`);
      validateRequiredString(entry.title, `payload.artifacts.clipImages[${index}].title`);
      if (entry.note !== undefined && typeof entry.note !== 'string') {
        throw new BridgeRequestError(400, `payload.artifacts.clipImages[${index}].note must be a string when provided.`);
      }
      validateRequiredString(entry.screenshotFileName, `payload.artifacts.clipImages[${index}].screenshotFileName`);
      validateRequiredString(entry.screenshotBase64, `payload.artifacts.clipImages[${index}].screenshotBase64`);
      validateRequiredString(entry.annotatedFileName, `payload.artifacts.clipImages[${index}].annotatedFileName`);
      validateRequiredString(entry.annotatedBase64, `payload.artifacts.clipImages[${index}].annotatedBase64`);
    });
  }

  if (payload.artifacts.clipsManifest !== undefined && payload.artifacts.clipsManifest !== null) {
    if (!isObject(payload.artifacts.clipsManifest)) {
      throw new BridgeRequestError(400, 'payload.artifacts.clipsManifest must be an object when provided.');
    }

    if (!Array.isArray(payload.artifacts.clipsManifest.orderedClipIds)) {
      throw new BridgeRequestError(400, 'payload.artifacts.clipsManifest.orderedClipIds must be an array.');
    }

    if (!Array.isArray(payload.artifacts.clipsManifest.clips)) {
      throw new BridgeRequestError(400, 'payload.artifacts.clipsManifest.clips must be an array.');
    }

    payload.artifacts.clipsManifest.clips.forEach((entry, index) => {
      if (!isObject(entry)) {
        throw new BridgeRequestError(400, `payload.artifacts.clipsManifest.clips[${index}] must be an object.`);
      }

      validateRequiredString(entry.clipId, `payload.artifacts.clipsManifest.clips[${index}].clipId`);
      validateRequiredString(entry.title, `payload.artifacts.clipsManifest.clips[${index}].title`);
      validateRequiredString(entry.note, `payload.artifacts.clipsManifest.clips[${index}].note`);
      validateRequiredString(
        entry.screenshotFileName,
        `payload.artifacts.clipsManifest.clips[${index}].screenshotFileName`,
      );
      validateRequiredString(
        entry.annotatedFileName,
        `payload.artifacts.clipsManifest.clips[${index}].annotatedFileName`,
      );
    });
  }

  return value;
}

function validateApprovalDecision(value) {
  if (!isObject(value)) {
    throw new BridgeRequestError(400, 'Approval decision must be a JSON object.');
  }

  if (value.behavior === 'allow') {
    return {
      behavior: 'allow',
      ...(isObject(value.updatedInput) ? { updatedInput: value.updatedInput } : {}),
      ...(Array.isArray(value.updatedPermissions) ? { updatedPermissions: value.updatedPermissions } : {}),
    };
  }

  if (value.behavior === 'deny') {
    return {
      behavior: 'deny',
      message:
        typeof value.message === 'string' && value.message.trim()
          ? value.message.trim()
          : 'Permission denied by the local bridge.',
      ...(value.interrupt === true ? { interrupt: true } : {}),
    };
  }

  throw new BridgeRequestError(400, 'Approval decision behavior must be allow or deny.');
}

function validateHookInstallRequest(value) {
  if (!isObject(value)) {
    throw new BridgeRequestError(400, 'Hook install request must be a JSON object.');
  }

  const settingsPath = typeof value.settingsPath === 'string' ? value.settingsPath.trim() : '';
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
  const token = typeof value.token === 'string' ? value.token.trim() : '';

  return {
    settingsPath,
    baseUrl,
    token,
  };
}

function validateHookPayload(value, eventName) {
  const supportedEvents = new Set([
    'session-start',
    'session-end',
    'user-prompt-submit',
    'pre-tool-use',
    'post-tool-use',
    'post-tool-use-failure',
    'permission-request',
    'stop',
  ]);

  if (!supportedEvents.has(eventName)) {
    throw new BridgeRequestError(400, `Unsupported hook endpoint: ${eventName}`);
  }

  if (!isObject(value)) {
    throw new BridgeRequestError(400, 'Hook payload must be a JSON object.');
  }

  if (typeof value.session_id !== 'string' || !value.session_id) {
    throw new BridgeRequestError(400, 'Hook payload must include session_id.');
  }

  return value;
}

function validateRequiredString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BridgeRequestError(400, `${fieldName} must be a non-empty string.`);
  }
}

class BridgeRequestError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'BridgeRequestError';
    this.statusCode = statusCode;
  }
}
