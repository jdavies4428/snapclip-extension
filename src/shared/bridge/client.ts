import { STORAGE_KEYS } from '../snapshot/storage';

export type BridgeWorkspace = {
  id: string;
  name: string;
  path: string;
  sessionCount: number;
  totalSessionCount: number;
  hiddenSessionCount: number;
  lastSeenAt: string | null;
  source: string;
};

export type BridgeSession = {
  id: string;
  workspaceId: string;
  workspaceName?: string | null;
  label: string;
  surface: string;
  cwd: string;
  lastSeenAt: string | null;
  status: string;
  activityState?: string | null;
  windowKey?: string | null;
  isWindowPrimary?: boolean;
  pendingApprovalCount?: number;
};

export type BridgeApproval = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  sessionId: string | null;
  workspaceId: string | null;
  hookEventName: string;
  toolName: string | null;
  toolInput: Record<string, unknown> | null;
  permissionSuggestions: unknown[];
  source: string | null;
};

export type BridgeTaskStatus = 'queued' | 'accepted' | 'in_progress' | 'completed' | 'failed';
export type BridgeDeliveryState =
  | 'queued'
  | 'delivering'
  | 'bundle_created'
  | 'delivered'
  | 'failed_after_bundle_creation';

export type BridgeTaskDelivery = {
  state: BridgeDeliveryState;
  target: 'bundle_only' | 'claude_session' | 'codex_bundle';
  sessionId: string | null;
  mode?: string;
  stdout?: string | null;
  error?: string | null;
};

export type BridgeTask = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: BridgeTaskStatus;
  workspaceId: string;
  sessionId: string | null;
  target: HandoffTarget;
  intent: HandoffIntent;
  title: string;
  bundlePath: string;
  bundleSignature: string;
  delivery: BridgeTaskDelivery;
};

export type BridgeTaskResponse = {
  taskId: string;
  status: 'accepted';
  bundlePath: string;
  delivery: BridgeTaskDelivery;
};

export type BridgeHookHttpHandler = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
};

export type BridgeHookMatcher = {
  matcher?: string;
  hooks: BridgeHookHttpHandler[];
};

export type BridgeHookConfig = {
  hooks: Record<string, BridgeHookMatcher[]>;
};

export type BridgeHookConfigResponse = {
  settingsPath: string;
  installedEvents: string[];
  hookConfig: BridgeHookConfig;
};

export type BridgeHookInstallResponse = {
  settingsPath: string;
  installedEvents: string[];
  hookConfig: BridgeHookConfig;
};

export type HandoffTarget = 'claude' | 'codex' | 'export_only';
export type HandoffIntent = 'fix' | 'plan' | 'explain';

export type BridgeTaskRequest = {
  workspaceId: string;
  sessionId: string | null;
  target: HandoffTarget;
  intent: HandoffIntent;
  payload: {
    title: string;
    comment: string;
    mimeType: 'image/png';
    imageBase64: string;
    annotations: Array<Record<string, unknown>>;
    artifacts: {
      screenshotFileName: 'screenshot.png';
      screenshotBase64: string;
      annotatedFileName: 'annotated.png';
      annotatedBase64: string;
      context: Record<string, unknown>;
      annotations: Record<string, unknown>;
      promptClaude: string;
      promptCodex: string;
    };
  };
};

export type BridgeConfig = {
  baseUrl: string;
  token: string;
};

export type BridgeApprovalDecision =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
    }
  | {
      behavior: 'deny';
      message?: string;
      interrupt?: boolean;
    };

const DEFAULT_BRIDGE_BASE_URL = 'http://127.0.0.1:4311';
const DEFAULT_BRIDGE_TOKEN = 'snapclip-dev';
const TERMINAL_TASK_STATUSES = new Set<BridgeTaskStatus>(['completed', 'failed']);

function normalizeBridgeBaseUrl(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  return normalized || DEFAULT_BRIDGE_BASE_URL;
}

function normalizeBridgeToken(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || DEFAULT_BRIDGE_TOKEN;
}

export async function getBridgeConfig(): Promise<BridgeConfig> {
  const result = await chrome.storage.local.get([STORAGE_KEYS.bridgeBaseUrl, STORAGE_KEYS.bridgeToken]);

  return {
    baseUrl: normalizeBridgeBaseUrl(result[STORAGE_KEYS.bridgeBaseUrl]),
    token: normalizeBridgeToken(result[STORAGE_KEYS.bridgeToken]),
  };
}

export async function setBridgeConfig(config: Partial<BridgeConfig>): Promise<BridgeConfig> {
  const current = await getBridgeConfig();
  const next = {
    baseUrl: normalizeBridgeBaseUrl(config.baseUrl ?? current.baseUrl),
    token: normalizeBridgeToken(config.token ?? current.token),
  };

  await chrome.storage.local.set({
    [STORAGE_KEYS.bridgeBaseUrl]: next.baseUrl,
    [STORAGE_KEYS.bridgeToken]: next.token,
  });

  return next;
}

async function fetchBridge<T>(path: string, init?: RequestInit): Promise<T> {
  const config = await getBridgeConfig();
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-SnapClip-Token': config.token,
      ...(init?.headers ?? {}),
    },
  });

  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || 'The local LLM Clip bridge request failed.');
  }

  return payload as T;
}

export async function listBridgeWorkspaces(): Promise<BridgeWorkspace[]> {
  const response = await fetchBridge<{ workspaces?: BridgeWorkspace[] }>('/workspaces');
  return Array.isArray(response.workspaces) ? response.workspaces : [];
}

export async function listBridgeSessions(workspaceId: string): Promise<BridgeSession[]> {
  const response = await fetchBridge<{ sessions?: BridgeSession[] }>(
    `/sessions?workspaceId=${encodeURIComponent(workspaceId)}&view=live`,
  );
  return Array.isArray(response.sessions) ? response.sessions : [];
}

export async function listBridgeActiveSessions(): Promise<BridgeSession[]> {
  const response = await fetchBridge<{ sessions?: BridgeSession[] }>('/sessions/active');
  return Array.isArray(response.sessions) ? response.sessions : [];
}

export async function listBridgeApprovals(options: {
  workspaceId?: string;
  sessionId?: string;
  status?: string;
} = {}): Promise<BridgeApproval[]> {
  const search = new URLSearchParams();
  if (options.workspaceId) {
    search.set('workspaceId', options.workspaceId);
  }
  if (options.sessionId) {
    search.set('sessionId', options.sessionId);
  }
  if (options.status) {
    search.set('status', options.status);
  }

  const suffix = search.size ? `?${search.toString()}` : '';
  const response = await fetchBridge<{ approvals?: BridgeApproval[] }>(`/approvals${suffix}`);
  return Array.isArray(response.approvals) ? response.approvals : [];
}

export async function resolveBridgeApproval(
  approvalId: string,
  decision: BridgeApprovalDecision,
): Promise<{ approvalId: string; status: string; sessionId: string | null }> {
  return fetchBridge(`/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: 'POST',
    body: JSON.stringify(decision),
  });
}

export async function getBridgeHookConfig(): Promise<BridgeHookConfigResponse> {
  return fetchBridge<BridgeHookConfigResponse>('/claude/hooks/config');
}

export async function installBridgeHooks(input: {
  settingsPath?: string;
  baseUrl?: string;
  token?: string;
} = {}): Promise<BridgeHookInstallResponse> {
  return fetchBridge<BridgeHookInstallResponse>('/claude/hooks/install', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function createBridgeTask(request: BridgeTaskRequest): Promise<BridgeTaskResponse> {
  return fetchBridge<BridgeTaskResponse>('/tasks', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export async function getBridgeTask(taskId: string, init?: RequestInit): Promise<BridgeTask> {
  return fetchBridge<BridgeTask>(`/tasks/${encodeURIComponent(taskId)}`, init);
}

export function isBridgeTaskTerminal(task: Pick<BridgeTask, 'status'>): boolean {
  return TERMINAL_TASK_STATUSES.has(task.status);
}

export async function waitForBridgeTask(
  taskId: string,
  options: {
    intervalMs?: number;
    maxAttempts?: number;
    onUpdate?: (task: BridgeTask) => void;
    signal?: AbortSignal;
  } = {},
) {
  const intervalMs = options.intervalMs ?? 1500;
  const maxAttempts = options.maxAttempts ?? 120;
  let latestTask: BridgeTask | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    throwIfAborted(options.signal);
    latestTask = await getBridgeTask(taskId, options.signal ? { signal: options.signal } : undefined);
    options.onUpdate?.(latestTask);
    if (isBridgeTaskTerminal(latestTask)) {
      return latestTask;
    }

    await delay(intervalMs, options.signal);
  }

  const timeoutError = new Error('The local bridge is still processing this handoff.');
  (timeoutError as Error & { task?: BridgeTask | null }).task = latestTask;
  throw timeoutError;
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const timeoutId = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, ms);

    const handleAbort = () => {
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener('abort', handleAbort);
      reject(createAbortError());
    };

    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function createAbortError() {
  const error = new Error('The local bridge task polling was cancelled.');
  error.name = 'AbortError';
  return error;
}
