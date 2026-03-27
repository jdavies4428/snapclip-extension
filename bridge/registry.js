import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';

import { createId, nowIso, shortHash, slugify, stableStringify } from './utils.js';

function buildWorkspaceId(workspacePath) {
  return `ws_${shortHash(resolve(workspacePath))}`;
}

function createWorkspaceRecord(workspacePath, source, timestamp) {
  return {
    id: buildWorkspaceId(workspacePath),
    name: basename(workspacePath) || workspacePath,
    path: resolve(workspacePath),
    lastSeenAt: timestamp,
    source,
  };
}

function createSessionRecord(payload, workspaceId, timestamp, eventName) {
  const cwd = resolve(typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd());
  const source = typeof payload.source === 'string' ? payload.source : null;
  const status = eventName === 'session-end' ? 'ended' : 'live';

  return {
    id: String(payload.session_id),
    workspaceId,
    target: 'claude',
    label: `${basename(cwd) || cwd} (${String(payload.session_id).slice(0, 8)})`,
    surface: 'claude_code',
    cwd,
    lastSeenAt: timestamp,
    status,
    activityState: payload.hook_event_name ?? null,
    windowKey: null,
    isWindowPrimary: true,
    source,
    startedAt: timestamp,
    endedAt: status === 'ended' ? timestamp : null,
    lastPromptAt: null,
    lastPromptPreview: '',
    lastToolName: null,
    recentHooks: [],
    pendingApprovalIds: [],
  };
}

function createRecentHook(eventName, payload, timestamp) {
  return {
    eventName,
    timestamp,
    toolName: typeof payload.tool_name === 'string' ? payload.tool_name : null,
    source: typeof payload.source === 'string' ? payload.source : null,
  };
}

function safeReadDirectory(directoryPath) {
  try {
    return readdirSync(directoryPath);
  } catch {
    return [];
  }
}

function safeReadJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatSessionLabel(cwd, sessionId) {
  return `${basename(cwd) || cwd} (${String(sessionId).slice(0, 8)})`;
}

function compactSessionTitle(title, fallback, maxWords = 8, maxChars = 36) {
  const normalized = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  if (!normalized) {
    return fallback;
  }

  const limitedWords = normalized.split(' ').slice(0, maxWords).join(' ');
  if (limitedWords.length <= maxChars) {
    return limitedWords;
  }

  return `${limitedWords.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeIsoTimestamp(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  try {
    return new Date(value).toISOString();
  } catch {
    return fallback;
  }
}

function normalizeWorkspaceFolders(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry) => typeof entry === 'string' && entry)
    .map((entry) => resolve(entry));
}

function inferSessionSurface(sessionEntry, ideLock) {
  const ideName = typeof ideLock?.ideName === 'string' ? ideLock.ideName.toLowerCase() : '';
  const entrypoint = typeof sessionEntry.entrypoint === 'string' ? sessionEntry.entrypoint.toLowerCase() : '';

  if (ideName === 'cursor' || entrypoint === 'claude-vscode') {
    return 'cursor';
  }

  if (ideName === 'vscode' || entrypoint.includes('vscode')) {
    return 'vscode';
  }

  return 'claude_code';
}

function inferWorkspaceSource(surface) {
  if (surface === 'codex') {
    return 'codex_session';
  }

  if (surface === 'cursor') {
    return 'cursor_session';
  }

  if (surface === 'vscode') {
    return 'vscode_session';
  }

  return 'claude_session';
}

function querySqliteRows(databasePath, sql) {
  if (!existsSync(databasePath)) {
    return [];
  }

  try {
    const output = execFileSync('sqlite3', [databasePath, '-tabs', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    return output ? output.split('\n').map((line) => line.split('\t')) : [];
  } catch {
    return [];
  }
}

function isCodexSource(value) {
  if (typeof value !== 'string' || !value) {
    return false;
  }

  return value === 'cli' || value === 'vscode' || value === 'exec';
}

function createApprovalSummary(approval) {
  return {
    id: approval.id,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
    status: approval.status,
    sessionId: approval.sessionId,
    workspaceId: approval.workspaceId,
    hookEventName: approval.hookEventName,
    toolName: approval.toolName,
    toolInput: approval.toolInput,
    permissionSuggestions: approval.permissionSuggestions,
    source: approval.source,
  };
}

function getPendingApprovalCount(session) {
  if (Array.isArray(session.pendingApprovalIds)) {
    return session.pendingApprovalIds.length;
  }

  return Number.isFinite(session.pendingApprovalCount) ? session.pendingApprovalCount : 0;
}

export class BridgeRegistry {
  constructor(config) {
    this.config = config;
    this.workspaces = new Map();
    this.sessions = new Map();
    this.tasks = new Map();
    this.pendingApprovals = new Map();

    const timestamp = nowIso();
    for (const workspaceRoot of config.workspaceRoots) {
      this.ensureWorkspace(workspaceRoot, 'configured', timestamp);
    }
  }

  ensureWorkspace(workspacePath, source = 'discovered', timestamp = nowIso()) {
    const normalizedPath = resolve(workspacePath);
    const workspaceId = buildWorkspaceId(normalizedPath);
    const existing = this.workspaces.get(workspaceId);

    if (existing) {
      existing.lastSeenAt = timestamp;
      if (source !== 'configured') {
        existing.source = source;
      }
      return existing;
    }

    const workspace = createWorkspaceRecord(normalizedPath, source, timestamp);
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  getWorkspace(workspaceId) {
    return this.workspaces.get(workspaceId) ?? null;
  }

  listWorkspaces() {
    const sessions = this.collectSessions();

    return Array.from(this.workspaces.values())
      .map((workspace) => {
        const workspaceSessions = sessions.filter((entry) => entry.workspaceId === workspace.id);
        const liveSessions = workspaceSessions.filter((entry) => entry.status === 'live');

        return {
          ...workspace,
          sessionCount: liveSessions.length,
          totalSessionCount: workspaceSessions.length,
          hiddenSessionCount: Math.max(0, workspaceSessions.length - liveSessions.length),
        };
      })
      .sort((left, right) => {
        const rightSeen = right.lastSeenAt ?? '';
        const leftSeen = left.lastSeenAt ?? '';
        return rightSeen.localeCompare(leftSeen) || left.name.localeCompare(right.name);
      });
  }

  upsertSession(payload, eventName) {
    if (typeof payload.session_id !== 'string' || !payload.session_id) {
      return null;
    }

    const timestamp = nowIso();
    const cwd = resolve(typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : this.config.cwd);
    const workspace = this.ensureWorkspace(cwd, 'claude_hook', timestamp);
    const existing = this.sessions.get(payload.session_id);

    if (!existing) {
      const session = createSessionRecord(payload, workspace.id, timestamp, eventName);
      session.recentHooks.push(createRecentHook(eventName, payload, timestamp));
      this.sessions.set(session.id, session);
      return session;
    }

    existing.workspaceId = workspace.id;
    existing.cwd = cwd;
    existing.label = `${basename(cwd) || cwd} (${String(existing.id).slice(0, 8)})`;
    existing.lastSeenAt = timestamp;
    existing.status = eventName === 'session-end' ? 'ended' : 'live';
    existing.activityState = payload.hook_event_name ?? eventName;
    existing.lastToolName = typeof payload.tool_name === 'string' ? payload.tool_name : existing.lastToolName;
    existing.recentHooks.push(createRecentHook(eventName, payload, timestamp));
    existing.recentHooks = existing.recentHooks.slice(-20);

    if (eventName === 'session-end') {
      existing.endedAt = timestamp;
      this.rejectPendingApprovalsForSession(existing.id, 'Claude session ended before approval was resolved.');
    }

    if (eventName === 'user-prompt-submit' && typeof payload.prompt === 'string') {
      existing.lastPromptAt = timestamp;
      existing.lastPromptPreview = payload.prompt.slice(0, 280);
    }

    return existing;
  }

  listSessions(workspaceId, options = {}) {
    const liveOnly = options.liveOnly ?? false;

    return this.collectSessions()
      .filter((session) => session.workspaceId === workspaceId)
      .filter((session) => (liveOnly ? session.status === 'live' : true))
      .sort((left, right) => (right.lastSeenAt ?? '').localeCompare(left.lastSeenAt ?? ''))
      .map((session) => ({
        id: session.id,
        workspaceId: session.workspaceId,
        target: session.target ?? 'claude',
        label: session.label,
        surface: session.surface,
        cwd: session.cwd,
        lastSeenAt: session.lastSeenAt,
        status: session.status,
        activityState: session.activityState,
        windowKey: session.windowKey,
        isWindowPrimary: session.isWindowPrimary,
        pendingApprovalCount: getPendingApprovalCount(session),
      }));
  }

  listActiveSessions() {
    const sessions = this.collectSessions();
    const workspaceIndex = new Map(
      Array.from(this.workspaces.values()).map((workspace) => [workspace.id, workspace]),
    );

    return sessions
      .filter((session) => session.status === 'live')
      .sort((left, right) => (right.lastSeenAt ?? '').localeCompare(left.lastSeenAt ?? ''))
      .map((session) => {
        const workspace = workspaceIndex.get(session.workspaceId);
        return {
          id: session.id,
          workspaceId: session.workspaceId,
          workspaceName: workspace?.name ?? session.workspaceId,
          target: session.target ?? 'claude',
          label: session.label,
          surface: session.surface,
          cwd: session.cwd,
          lastSeenAt: session.lastSeenAt,
          status: session.status,
          activityState: session.activityState,
          windowKey: session.windowKey,
          isWindowPrimary: session.isWindowPrimary,
          pendingApprovalCount: getPendingApprovalCount(session),
        };
      });
  }

  listApprovals(options = {}) {
    const {
      workspaceId = '',
      sessionId = '',
      status = '',
    } = options;

    return Array.from(this.pendingApprovals.values())
      .filter((approval) => (workspaceId ? approval.workspaceId === workspaceId : true))
      .filter((approval) => (sessionId ? approval.sessionId === sessionId : true))
      .filter((approval) => (status ? approval.status === status : true))
      .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''))
      .map(createApprovalSummary);
  }

  createTaskRecord(summary) {
    const timestamp = nowIso();
    const isSessionResumeTarget =
      (summary.target === 'claude' || summary.target === 'codex') &&
      typeof summary.sessionId === 'string' &&
      summary.sessionId;
    const task = {
      id: createId('task'),
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'queued',
      workspaceId: summary.workspaceId,
      sessionId: summary.sessionId,
      target: summary.target,
      intent: summary.intent,
      title: summary.title,
      bundlePath: summary.bundlePath,
      bundleSignature: summary.bundleSignature,
      delivery: {
        state: isSessionResumeTarget ? 'queued' : 'bundle_created',
        target: isSessionResumeTarget
          ? summary.target === 'codex'
            ? 'codex_session'
            : 'claude_session'
          : summary.target === 'codex'
            ? 'codex_bundle'
            : 'bundle_only',
        sessionId: summary.sessionId,
        mode: isSessionResumeTarget ? (summary.target === 'codex' ? 'codex_resume' : 'claude_resume') : 'bundle_only',
        stdout: null,
        error: null,
      },
    };

    this.tasks.set(task.id, task);
    return task;
  }

  updateTask(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return null;
    }

    if (updates.status) {
      task.status = updates.status;
    }

    if (updates.delivery) {
      task.delivery = {
        ...task.delivery,
        ...updates.delivery,
      };
    }

    task.updatedAt = nowIso();
    return task;
  }

  getTask(taskId) {
    return this.tasks.get(taskId) ?? null;
  }

  createPendingApproval(payload) {
    const timestamp = nowIso();
    const session = this.upsertSession(payload, 'permission-request');
    const approvalId = createId('approval');

    let resolveDecision;
    let rejectDecision;
    const result = new Promise((resolve, reject) => {
      resolveDecision = resolve;
      rejectDecision = reject;
    });

    const timeoutId = setTimeout(() => {
      const pending = this.pendingApprovals.get(approvalId);
      if (!pending || pending.status !== 'pending') {
        return;
      }

      pending.status = 'expired';
      this.pendingApprovals.delete(approvalId);
      if (session) {
        session.pendingApprovalIds = session.pendingApprovalIds.filter((entry) => entry !== approvalId);
      }
      rejectDecision(new Error('Approval request timed out.'));
    }, 10 * 60 * 1000);

    const approval = {
      id: approvalId,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'pending',
      sessionId: session?.id ?? null,
      workspaceId: session?.workspaceId ?? null,
      hookEventName: payload.hook_event_name ?? 'PermissionRequest',
      toolName: typeof payload.tool_name === 'string' ? payload.tool_name : null,
      toolInput: payload.tool_input ?? null,
      permissionSuggestions: Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions : [],
      source: typeof payload.source === 'string' ? payload.source : null,
      payload,
      result,
      resolveDecision,
      rejectDecision,
      timeoutId,
    };

    this.pendingApprovals.set(approvalId, approval);
    if (session) {
      session.pendingApprovalIds.push(approvalId);
    }

    return approval;
  }

  resolveApproval(approvalId, decision) {
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval) {
      return null;
    }

    clearTimeout(approval.timeoutId);
    approval.status = 'resolved';
    approval.updatedAt = nowIso();
    this.pendingApprovals.delete(approvalId);

    if (approval.sessionId) {
      const session = this.sessions.get(approval.sessionId);
      if (session) {
        session.pendingApprovalIds = session.pendingApprovalIds.filter((entry) => entry !== approvalId);
      }
    }

    approval.resolveDecision({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision,
      },
    });

    return approval;
  }

  rejectApproval(approvalId, reason) {
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval) {
      return null;
    }

    clearTimeout(approval.timeoutId);
    approval.status = 'rejected';
    approval.updatedAt = nowIso();
    this.pendingApprovals.delete(approvalId);
    if (approval.sessionId) {
      const session = this.sessions.get(approval.sessionId);
      if (session) {
        session.pendingApprovalIds = session.pendingApprovalIds.filter((entry) => entry !== approvalId);
      }
    }
    approval.rejectDecision(new Error(reason));
    return approval;
  }

  rejectPendingApprovalsForSession(sessionId, reason) {
    const session = this.sessions.get(sessionId);
    if (!session || session.pendingApprovalIds.length === 0) {
      return [];
    }

    const approvalIds = [...session.pendingApprovalIds];
    return approvalIds
      .map((approvalId) => this.rejectApproval(approvalId, reason))
      .filter(Boolean);
  }

  buildDeterministicBundleSignature(taskRequest) {
    return shortHash(
      stableStringify({
        workspaceId: taskRequest.workspaceId,
        sessionId: taskRequest.sessionId,
        target: taskRequest.target,
        intent: taskRequest.intent,
        payload: taskRequest.payload,
      }),
      16,
    );
  }

  buildBundleSlug(taskRequest) {
    return `${slugify(taskRequest.payload?.title, 'incident')}-${this.buildDeterministicBundleSignature(taskRequest)}`;
  }

  collectSessions() {
    const persistedSessions = Array.from(this.sessions.values());
    const livePersistedIds = new Set(
      persistedSessions.filter((session) => session.status === 'live').map((session) => session.id),
    );

    return [
      ...persistedSessions,
      ...this.listSupplementalClaudeSessions(livePersistedIds),
      ...this.listSupplementalCodexSessions(livePersistedIds),
    ];
  }

  listSupplementalClaudeSessions(livePersistedIds) {
    const claudeStateRoot = resolve(this.config.claudeStateRoot ?? resolve(homedir(), '.claude'));
    const sessionsDirectory = resolve(claudeStateRoot, 'sessions');
    const ideDirectory = resolve(claudeStateRoot, 'ide');
    const timestamp = nowIso();
    const ideLocks = safeReadDirectory(ideDirectory)
      .filter((fileName) => fileName.endsWith('.lock'))
      .map((fileName) => safeReadJsonFile(resolve(ideDirectory, fileName)))
      .filter(Boolean);

    return safeReadDirectory(sessionsDirectory)
      .filter((fileName) => fileName.endsWith('.json'))
      .map((fileName) => safeReadJsonFile(resolve(sessionsDirectory, fileName)))
      .filter((entry) => Boolean(entry) && typeof entry.sessionId === 'string' && typeof entry.cwd === 'string')
      .filter((entry) => !livePersistedIds.has(entry.sessionId))
      .filter((entry) => isProcessRunning(Number(entry.pid)))
      .map((entry) => {
        const cwd = resolve(entry.cwd);
        const ideLock = ideLocks.find((lockEntry) => normalizeWorkspaceFolders(lockEntry.workspaceFolders).includes(cwd));
        const surface = inferSessionSurface(entry, ideLock);
        const workspace = this.ensureWorkspace(cwd, inferWorkspaceSource(surface), timestamp);

        return {
          id: entry.sessionId,
          workspaceId: workspace.id,
          target: 'claude',
          label: formatSessionLabel(cwd, entry.sessionId),
          surface,
          cwd,
          lastSeenAt: normalizeIsoTimestamp(entry.startedAt, timestamp),
          status: 'live',
          activityState: 'SessionStart',
          windowKey: typeof ideLock?.authToken === 'string' ? ideLock.authToken : null,
          isWindowPrimary: true,
          pendingApprovalCount: 0,
        };
      });
  }

  listSupplementalCodexSessions(livePersistedIds) {
    const codexStateRoot = resolve(this.config.codexStateRoot ?? resolve(homedir(), '.codex'));
    const databasePath = resolve(codexStateRoot, 'state_5.sqlite');
    const timestamp = nowIso();
    const discoveryWindowSeconds = 8 * 60 * 60;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const rows = querySqliteRows(
      databasePath,
      [
        'select id, source, cwd, title, updated_at',
        'from threads',
        `where archived = 0 and updated_at >= ${nowSeconds - discoveryWindowSeconds}`,
        'order by updated_at desc',
        'limit 20;',
      ].join(' '),
    );

    return rows
      .map(([id, source, cwd, title, updatedAt]) => ({
        id,
        source,
        cwd,
        title,
        updatedAt: Number(updatedAt),
      }))
      .filter((entry) => typeof entry.id === 'string' && entry.id)
      .filter((entry) => !livePersistedIds.has(entry.id))
      .filter((entry) => typeof entry.cwd === 'string' && entry.cwd)
      .filter((entry) => isCodexSource(entry.source))
      .map((entry) => {
        const cwd = resolve(entry.cwd);
        const workspace = this.ensureWorkspace(cwd, inferWorkspaceSource('codex'), timestamp);
        const title = typeof entry.title === 'string' ? entry.title.trim() : '';
        const labelBase = basename(cwd) || cwd;
        const fallbackLabel = `${labelBase} (Codex ${String(entry.id).slice(0, 6)})`;

        return {
          id: entry.id,
          workspaceId: workspace.id,
          target: 'codex',
          label: compactSessionTitle(title, fallbackLabel),
          surface: 'codex',
          cwd,
          lastSeenAt: normalizeIsoTimestamp(entry.updatedAt * 1000, timestamp),
          status: 'live',
          activityState: title || 'CodexResume',
          windowKey: null,
          isWindowPrimary: true,
          pendingApprovalCount: 0,
        };
      });
  }
}
