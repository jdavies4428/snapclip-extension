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
  label: string;
  surface: string;
  cwd: string;
  lastSeenAt: string | null;
  status: string;
  activityState?: string | null;
  windowKey?: string | null;
  isWindowPrimary?: boolean;
};

export type BridgeDeliveryState = 'bundle_created' | 'delivered' | 'failed_after_bundle_creation';

export type BridgeTaskDelivery = {
  state: BridgeDeliveryState;
  target: 'bundle_only' | 'claude_session' | 'codex_bundle';
  sessionId: string | null;
  mode?: string;
  stdout?: string | null;
  error?: string | null;
};

export type BridgeTaskResponse = {
  taskId: string;
  status: 'accepted';
  bundlePath: string;
  delivery: BridgeTaskDelivery;
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

const DEFAULT_BRIDGE_BASE_URL = 'http://127.0.0.1:4311';
const DEFAULT_BRIDGE_TOKEN = 'snapclip-dev';

export type BridgeConfig = {
  baseUrl: string;
  token: string;
};

function normalizeBridgeBaseUrl(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  return normalized || DEFAULT_BRIDGE_BASE_URL;
}

function normalizeBridgeToken(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || DEFAULT_BRIDGE_TOKEN;
}

export async function getBridgeConfig(): Promise<BridgeConfig> {
  const result = await chrome.storage.local.get(['snapclip.bridge.baseUrl', 'snapclip.bridge.token']);

  return {
    baseUrl: normalizeBridgeBaseUrl(result['snapclip.bridge.baseUrl']),
    token: normalizeBridgeToken(result['snapclip.bridge.token']),
  };
}

export async function setBridgeConfig(config: Partial<BridgeConfig>): Promise<BridgeConfig> {
  const current = await getBridgeConfig();
  const next = {
    baseUrl: normalizeBridgeBaseUrl(config.baseUrl ?? current.baseUrl),
    token: normalizeBridgeToken(config.token ?? current.token),
  };

  await chrome.storage.local.set({
    'snapclip.bridge.baseUrl': next.baseUrl,
    'snapclip.bridge.token': next.token,
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

export async function createBridgeTask(request: BridgeTaskRequest): Promise<BridgeTaskResponse> {
  return fetchBridge<BridgeTaskResponse>('/tasks', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}
