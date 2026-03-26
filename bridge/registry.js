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
    return Array.from(this.workspaces.values())
      .map((workspace) => {
        const sessions = Array.from(this.sessions.values()).filter((entry) => entry.workspaceId === workspace.id);
        const liveSessions = sessions.filter((entry) => entry.status === 'live');

        return {
          ...workspace,
          sessionCount: liveSessions.length,
          totalSessionCount: sessions.length,
          hiddenSessionCount: Math.max(0, sessions.length - liveSessions.length),
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

    return Array.from(this.sessions.values())
      .filter((session) => session.workspaceId === workspaceId)
      .filter((session) => (liveOnly ? session.status === 'live' : true))
      .sort((left, right) => (right.lastSeenAt ?? '').localeCompare(left.lastSeenAt ?? ''))
      .map((session) => ({
        id: session.id,
        workspaceId: session.workspaceId,
        label: session.label,
        surface: session.surface,
        cwd: session.cwd,
        lastSeenAt: session.lastSeenAt,
        status: session.status,
        activityState: session.activityState,
        windowKey: session.windowKey,
        isWindowPrimary: session.isWindowPrimary,
        pendingApprovalCount: session.pendingApprovalIds.length,
      }));
  }

  listActiveSessions() {
    const workspaceIndex = new Map(
      Array.from(this.workspaces.values()).map((workspace) => [workspace.id, workspace]),
    );

    return Array.from(this.sessions.values())
      .filter((session) => session.status === 'live')
      .sort((left, right) => (right.lastSeenAt ?? '').localeCompare(left.lastSeenAt ?? ''))
      .map((session) => {
        const workspace = workspaceIndex.get(session.workspaceId);
        return {
          id: session.id,
          workspaceId: session.workspaceId,
          workspaceName: workspace?.name ?? session.workspaceId,
          label: session.label,
          surface: session.surface,
          cwd: session.cwd,
          lastSeenAt: session.lastSeenAt,
          status: session.status,
          activityState: session.activityState,
          windowKey: session.windowKey,
          isWindowPrimary: session.isWindowPrimary,
          pendingApprovalCount: session.pendingApprovalIds.length,
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
    const isClaudeResumeTarget = summary.target === 'claude' && typeof summary.sessionId === 'string' && summary.sessionId;
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
        state: isClaudeResumeTarget ? 'queued' : 'bundle_created',
        target: isClaudeResumeTarget ? 'claude_session' : summary.target === 'codex' ? 'codex_bundle' : 'bundle_only',
        sessionId: summary.sessionId,
        mode: isClaudeResumeTarget ? 'claude_resume' : 'bundle_only',
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
}
