import { useEffect, useState } from 'react';
import {
  getBridgeConfig,
  getBridgeHookConfig,
  installBridgeHooks,
  listBridgeApprovals,
  listBridgeSessions,
  listBridgeWorkspaces,
  setBridgeConfig,
  type BridgeApproval,
  type BridgeConfig,
  type BridgeHookInstallResponse,
  type BridgeSession,
  type BridgeWorkspace,
} from '../../shared/bridge/client';

function toBridgeErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return 'LLM Clip could not reach the local handoff bridge.';
}

function pickWorkspaceId(workspaces: BridgeWorkspace[], currentValue: string): string {
  if (currentValue && workspaces.some((workspace) => workspace.id === currentValue)) {
    return currentValue;
  }

  const withSessions = workspaces.find((workspace) => workspace.sessionCount > 0);
  return withSessions?.id ?? workspaces[0]?.id ?? '';
}

function pickSessionId(sessions: BridgeSession[], currentValue: string): string {
  if (currentValue && sessions.some((session) => session.id === currentValue)) {
    return currentValue;
  }

  return sessions.length === 1 ? sessions[0]?.id ?? '' : '';
}

export function useBridgeState(options: {
  enabled: boolean;
  reloadKey: string;
}) {
  const { enabled, reloadKey } = options;
  const [bridgeWorkspaces, setBridgeWorkspaces] = useState<BridgeWorkspace[]>([]);
  const [bridgeSessions, setBridgeSessions] = useState<BridgeSession[]>([]);
  const [bridgeApprovals, setBridgeApprovals] = useState<BridgeApproval[]>([]);
  const [bridgeError, setBridgeError] = useState('');
  const [bridgeBaseUrl, setBridgeBaseUrl] = useState('http://127.0.0.1:4311');
  const [bridgeToken, setBridgeToken] = useState('snapclip-dev');
  const [hookSettingsPath, setHookSettingsPath] = useState('');
  const [hookInstalledEvents, setHookInstalledEvents] = useState<string[]>([]);
  const [isBridgeLoading, setIsBridgeLoading] = useState(false);
  const [isSessionLoading, setIsSessionLoading] = useState(false);
  const [isApprovalLoading, setIsApprovalLoading] = useState(false);
  const [isHookInstalling, setIsHookInstalling] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState('');

  useEffect(() => {
    if (enabled) {
      return;
    }

    setBridgeWorkspaces([]);
    setBridgeSessions([]);
    setBridgeApprovals([]);
    setBridgeError('');
    setHookSettingsPath('');
    setHookInstalledEvents([]);
    setIsBridgeLoading(false);
    setIsSessionLoading(false);
    setIsApprovalLoading(false);
    setIsHookInstalling(false);
    setSelectedWorkspaceId('');
    setSelectedSessionId('');
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;

    async function loadBridgeState() {
      setIsBridgeLoading(true);

      try {
        const config = await getBridgeConfig();
        if (cancelled) {
          return;
        }

        setBridgeBaseUrl(config.baseUrl);
        setBridgeToken(config.token);

        const [workspaces, hookConfig] = await Promise.all([
          listBridgeWorkspaces(),
          getBridgeHookConfig().catch(() => null),
        ]);
        if (cancelled) {
          return;
        }

        setBridgeWorkspaces(workspaces);
        setBridgeError(workspaces.length ? '' : 'The local LLM Clip bridge returned no workspaces.');
        setHookSettingsPath(hookConfig?.settingsPath ?? '');
        setHookInstalledEvents(hookConfig?.installedEvents ?? []);
        setSelectedWorkspaceId((currentValue) => pickWorkspaceId(workspaces, currentValue));
      } catch (error) {
        if (!cancelled) {
          setBridgeError(toBridgeErrorMessage(error));
          setBridgeWorkspaces([]);
          setBridgeSessions([]);
          setBridgeApprovals([]);
          setSelectedWorkspaceId('');
          setSelectedSessionId('');
        }
      } finally {
        if (!cancelled) {
          setIsBridgeLoading(false);
        }
      }
    }

    void loadBridgeState();

    return () => {
      cancelled = true;
    };
  }, [enabled, reloadKey]);

  useEffect(() => {
    if (!enabled || !selectedWorkspaceId) {
      setBridgeSessions([]);
      setBridgeApprovals([]);
      setSelectedSessionId('');
      return;
    }

    let cancelled = false;

    async function loadWorkspaceContext() {
      setIsSessionLoading(true);

      try {
        const sessions = await listBridgeSessions(selectedWorkspaceId);

        if (cancelled) {
          return;
        }

        setBridgeSessions(sessions);
        setBridgeApprovals([]);
        setSelectedSessionId((currentValue) => pickSessionId(sessions, currentValue));
      } catch (error) {
        if (!cancelled) {
          setBridgeSessions([]);
          setBridgeApprovals([]);
          setSelectedSessionId('');
          setBridgeError(toBridgeErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setIsSessionLoading(false);
        }
      }
    }

    void loadWorkspaceContext();

    return () => {
      cancelled = true;
    };
  }, [enabled, selectedWorkspaceId]);

  useEffect(() => {
    if (!enabled || !selectedWorkspaceId || !selectedSessionId) {
      setBridgeApprovals([]);
      setIsApprovalLoading(false);
      return;
    }

    let cancelled = false;

    async function loadApprovals() {
      setIsApprovalLoading(true);

      try {
        const approvals = await listBridgeApprovals({
          workspaceId: selectedWorkspaceId,
          sessionId: selectedSessionId,
          status: 'pending',
        });

        if (cancelled) {
          return;
        }

        setBridgeApprovals(approvals);
        setBridgeError('');
      } catch (error) {
        if (!cancelled) {
          setBridgeApprovals([]);
          setBridgeError(toBridgeErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setIsApprovalLoading(false);
        }
      }
    }

    void loadApprovals();

    return () => {
      cancelled = true;
    };
  }, [enabled, selectedSessionId, selectedWorkspaceId]);

  async function saveSettings(config: Partial<BridgeConfig>) {
    const nextConfig = await setBridgeConfig(config);

    setBridgeBaseUrl(nextConfig.baseUrl);
    setBridgeToken(nextConfig.token);

    const [workspaces, hookConfig] = await Promise.all([
      listBridgeWorkspaces(),
      getBridgeHookConfig().catch(() => null),
    ]);
    setBridgeWorkspaces(workspaces);
    setBridgeError(workspaces.length ? '' : 'The local LLM Clip bridge returned no workspaces.');
    setHookSettingsPath(hookConfig?.settingsPath ?? '');
    setHookInstalledEvents(hookConfig?.installedEvents ?? []);
    setSelectedWorkspaceId((currentValue) => pickWorkspaceId(workspaces, currentValue));

    return nextConfig;
  }

  async function refreshSessions(workspaceId = selectedWorkspaceId) {
    if (!workspaceId) {
      setBridgeSessions([]);
      setSelectedSessionId('');
      return [];
    }

    setIsSessionLoading(true);

    try {
      const sessions = await listBridgeSessions(workspaceId);
      setBridgeSessions(sessions);
      setSelectedSessionId((currentValue) => pickSessionId(sessions, currentValue));
      setBridgeError('');
      return sessions;
    } catch (error) {
      setBridgeError(toBridgeErrorMessage(error));
      throw error;
    } finally {
      setIsSessionLoading(false);
    }
  }

  async function refreshApprovals(workspaceId = selectedWorkspaceId, sessionId = selectedSessionId) {
    if (!workspaceId || !sessionId) {
      setBridgeApprovals([]);
      return [];
    }

    setIsApprovalLoading(true);

    try {
      const approvals = await listBridgeApprovals({
        workspaceId,
        ...(sessionId ? { sessionId } : {}),
        status: 'pending',
      });
      setBridgeApprovals(approvals);
      setBridgeError('');
      return approvals;
    } catch (error) {
      setBridgeError(toBridgeErrorMessage(error));
      throw error;
    } finally {
      setIsApprovalLoading(false);
    }
  }

  async function installHooks(settingsPath = hookSettingsPath): Promise<BridgeHookInstallResponse> {
    setIsHookInstalling(true);

    try {
      const result = await installBridgeHooks({
        ...(settingsPath ? { settingsPath } : {}),
        baseUrl: bridgeBaseUrl,
        token: bridgeToken,
      });

      setHookSettingsPath(result.settingsPath);
      setHookInstalledEvents(result.installedEvents);
      setBridgeError('');
      return result;
    } catch (error) {
      const message = toBridgeErrorMessage(error);
      setBridgeError(message);
      throw new Error(message);
    } finally {
      setIsHookInstalling(false);
    }
  }

  return {
    bridgeWorkspaces,
    bridgeSessions,
    bridgeApprovals,
    bridgeError,
    bridgeBaseUrl,
    bridgeToken,
    hookSettingsPath,
    hookInstalledEvents,
    isBridgeLoading,
    isSessionLoading,
    isApprovalLoading,
    isHookInstalling,
    selectedWorkspaceId,
    selectedSessionId,
    setBridgeBaseUrl,
    setBridgeToken,
    setSelectedWorkspaceId,
    setSelectedSessionId,
    setBridgeError,
    saveSettings,
    refreshSessions,
    refreshApprovals,
    installHooks,
  };
}
