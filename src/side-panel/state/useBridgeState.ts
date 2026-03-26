import { useEffect, useState } from 'react';
import {
  getBridgeHealth,
  getBridgeConfig,
  getBridgeHookConfig,
  installBridgeHooks,
  listBridgeActiveSessions,
  listBridgeApprovals,
  listBridgeSessions,
  listBridgeWorkspaces,
  setBridgeConfig,
  type BridgeApproval,
  type BridgeConfig,
  type BridgeHealth,
  type BridgeHookInstallResponse,
  type BridgeSession,
  type BridgeWorkspace,
} from '../../shared/bridge/client';
import { pickSessionId, pickWorkspaceId } from '../../shared/bridge/selection';
import { STORAGE_KEYS } from '../../shared/snapshot/storage';

function toBridgeErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return 'LLM Clip could not reach the local handoff bridge.';
}

export function useBridgeState(options: {
  enabled: boolean;
  reloadKey: string;
}) {
  const { enabled, reloadKey } = options;
  const [bridgeWorkspaces, setBridgeWorkspaces] = useState<BridgeWorkspace[]>([]);
  const [bridgeSessions, setBridgeSessions] = useState<BridgeSession[]>([]);
  const [bridgeApprovals, setBridgeApprovals] = useState<BridgeApproval[]>([]);
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealth | null>(null);
  const [bridgeDiscoveryMode, setBridgeDiscoveryMode] = useState<'active' | 'workspace'>('active');
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
  const [hasHydratedBridgeSelection, setHasHydratedBridgeSelection] = useState(false);

  function buildActiveWorkspaces(sessions: BridgeSession[]): BridgeWorkspace[] {
    const activeWorkspaceMap = new Map<string, BridgeWorkspace>();
    sessions.forEach((session) => {
      const existing = activeWorkspaceMap.get(session.workspaceId);
      if (existing) {
        existing.sessionCount += 1;
        existing.totalSessionCount += 1;
        existing.lastSeenAt = session.lastSeenAt ?? existing.lastSeenAt;
        return;
      }

      activeWorkspaceMap.set(session.workspaceId, {
        id: session.workspaceId,
        name: session.workspaceName || session.workspaceId,
        path: session.cwd,
        sessionCount: 1,
        totalSessionCount: 1,
        hiddenSessionCount: 0,
        lastSeenAt: session.lastSeenAt ?? null,
        source: 'active_session',
      });
    });

    return Array.from(activeWorkspaceMap.values());
  }

  useEffect(() => {
    if (!enabled || !hasHydratedBridgeSelection) {
      return;
    }

    void chrome.storage.local.set({
      [STORAGE_KEYS.bridgeSelectedWorkspaceId]: selectedWorkspaceId,
      [STORAGE_KEYS.bridgeSelectedSessionId]: selectedSessionId,
    });
  }, [enabled, hasHydratedBridgeSelection, selectedSessionId, selectedWorkspaceId]);

  useEffect(() => {
    if (enabled) {
      return;
    }

    setBridgeWorkspaces([]);
    setBridgeSessions([]);
    setBridgeApprovals([]);
    setBridgeHealth(null);
    setBridgeDiscoveryMode('active');
    setBridgeError('');
    setHookSettingsPath('');
    setHookInstalledEvents([]);
    setIsBridgeLoading(false);
    setIsSessionLoading(false);
    setIsApprovalLoading(false);
    setIsHookInstalling(false);
    setSelectedWorkspaceId('');
    setSelectedSessionId('');
    setHasHydratedBridgeSelection(false);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;

    async function loadBridgeState() {
      setIsBridgeLoading(true);

      try {
        const [config, persistedSelection] = await Promise.all([
          getBridgeConfig(),
          chrome.storage.local.get([
            STORAGE_KEYS.bridgeSelectedWorkspaceId,
            STORAGE_KEYS.bridgeSelectedSessionId,
          ]),
        ]);
        if (cancelled) {
          return;
        }

        setBridgeBaseUrl(config.baseUrl);
        setBridgeToken(config.token);

        const [health, hookConfig] = await Promise.all([
          getBridgeHealth(),
          getBridgeHookConfig().catch(() => null),
        ]);
        if (cancelled) {
          return;
        }

        setBridgeHealth(health);
        setHookSettingsPath(hookConfig?.settingsPath ?? '');
        setHookInstalledEvents(hookConfig?.installedEvents ?? []);
        const persistedWorkspaceId =
          typeof persistedSelection[STORAGE_KEYS.bridgeSelectedWorkspaceId] === 'string'
            ? persistedSelection[STORAGE_KEYS.bridgeSelectedWorkspaceId]
            : '';
        const persistedSessionId =
          typeof persistedSelection[STORAGE_KEYS.bridgeSelectedSessionId] === 'string'
            ? persistedSelection[STORAGE_KEYS.bridgeSelectedSessionId]
            : '';

        try {
          const activeSessions = await listBridgeActiveSessions();
          if (cancelled) {
            return;
          }

          if (activeSessions.length) {
            setBridgeDiscoveryMode('active');
            setBridgeSessions(activeSessions);
            const nextWorkspaces = buildActiveWorkspaces(activeSessions);
            const nextSessionId = pickSessionId(activeSessions, persistedSessionId);
            const nextWorkspaceId =
              activeSessions.find((session) => session.id === nextSessionId)?.workspaceId ||
              activeSessions[0]?.workspaceId ||
              persistedWorkspaceId ||
              '';
            setBridgeWorkspaces(nextWorkspaces);
            setSelectedSessionId(nextSessionId);
            setSelectedWorkspaceId(nextWorkspaceId);
            setBridgeError('');
            setHasHydratedBridgeSelection(true);
            return;
          }
        } catch {
          // Fall back to workspace-scoped discovery.
        }

        const workspaces = await listBridgeWorkspaces();
        if (cancelled) {
          return;
        }

        setBridgeDiscoveryMode('workspace');
        setBridgeWorkspaces(workspaces);
        setBridgeError(workspaces.length ? '' : 'The local companion is running, but no configured workspaces were found.');
        setSelectedWorkspaceId((currentValue) => pickWorkspaceId(workspaces, currentValue || persistedWorkspaceId));
        setSelectedSessionId((currentValue) => currentValue || persistedSessionId);
        setHasHydratedBridgeSelection(true);
      } catch (error) {
        if (!cancelled) {
          setBridgeError(toBridgeErrorMessage(error));
          setBridgeHealth(null);
          setBridgeWorkspaces([]);
          setBridgeSessions([]);
          setBridgeApprovals([]);
          setSelectedWorkspaceId('');
          setSelectedSessionId('');
          setHasHydratedBridgeSelection(true);
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
    if (!enabled || (bridgeDiscoveryMode === 'workspace' && !selectedWorkspaceId)) {
      setBridgeSessions([]);
      setBridgeApprovals([]);
      if (bridgeDiscoveryMode === 'workspace') {
        setSelectedSessionId('');
      }
      return;
    }

    let cancelled = false;

    async function loadWorkspaceContext() {
      setIsSessionLoading(true);

      try {
        if (bridgeDiscoveryMode === 'active') {
          const sessions = await listBridgeActiveSessions();

          if (cancelled) {
            return;
          }

          const nextSessionId = pickSessionId(sessions, selectedSessionId);
          setBridgeSessions(sessions);
          setBridgeWorkspaces(buildActiveWorkspaces(sessions));
          setBridgeApprovals([]);
          setSelectedSessionId(nextSessionId);
          setSelectedWorkspaceId(
            sessions.find((session) => session.id === nextSessionId)?.workspaceId || sessions[0]?.workspaceId || '',
          );
          setBridgeError('');
          return;
        }

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
  }, [bridgeDiscoveryMode, enabled, selectedWorkspaceId]);

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

    const [health, hookConfig] = await Promise.all([
      getBridgeHealth(),
      getBridgeHookConfig().catch(() => null),
    ]);
    setBridgeHealth(health);
    setHookSettingsPath(hookConfig?.settingsPath ?? '');
    setHookInstalledEvents(hookConfig?.installedEvents ?? []);
    try {
      const activeSessions = await listBridgeActiveSessions();
      if (activeSessions.length) {
        const nextSessionId = pickSessionId(activeSessions, selectedSessionId);
        setBridgeDiscoveryMode('active');
        setBridgeSessions(activeSessions);
        setBridgeWorkspaces(buildActiveWorkspaces(activeSessions));
        setBridgeApprovals([]);
        setSelectedSessionId(nextSessionId);
        setSelectedWorkspaceId(
          activeSessions.find((session) => session.id === nextSessionId)?.workspaceId || activeSessions[0]?.workspaceId || '',
        );
        setBridgeError('');
        setHasHydratedBridgeSelection(true);
        return nextConfig;
      }
    } catch {
      // Fall back to workspaces.
    }
    const workspaces = await listBridgeWorkspaces();
    setBridgeDiscoveryMode('workspace');
    setBridgeWorkspaces(workspaces);
    setBridgeApprovals([]);
    setBridgeError(workspaces.length ? '' : 'The local companion is running, but no configured workspaces were found.');
    const persistedSelection = await chrome.storage.local.get([
      STORAGE_KEYS.bridgeSelectedWorkspaceId,
      STORAGE_KEYS.bridgeSelectedSessionId,
    ]);
    const persistedWorkspaceId =
      typeof persistedSelection[STORAGE_KEYS.bridgeSelectedWorkspaceId] === 'string'
        ? persistedSelection[STORAGE_KEYS.bridgeSelectedWorkspaceId]
        : '';
    const persistedSessionId =
      typeof persistedSelection[STORAGE_KEYS.bridgeSelectedSessionId] === 'string'
        ? persistedSelection[STORAGE_KEYS.bridgeSelectedSessionId]
        : '';
    setSelectedWorkspaceId((currentValue) => pickWorkspaceId(workspaces, currentValue || persistedWorkspaceId));
    setSelectedSessionId((currentValue) => currentValue || persistedSessionId);
    setHasHydratedBridgeSelection(true);

    return nextConfig;
  }

  async function refreshSessions(workspaceId = selectedWorkspaceId) {
    if (bridgeDiscoveryMode !== 'active' && !workspaceId) {
      setBridgeSessions([]);
      setSelectedSessionId('');
      return [];
    }

    setIsSessionLoading(true);

    try {
      if (bridgeDiscoveryMode === 'active') {
        const sessions = await listBridgeActiveSessions();
        const nextSessionId = pickSessionId(sessions, selectedSessionId);
        setBridgeSessions(sessions);
        setBridgeWorkspaces(buildActiveWorkspaces(sessions));
        setSelectedSessionId(nextSessionId);
        setSelectedWorkspaceId(
          sessions.find((session) => session.id === nextSessionId)?.workspaceId || sessions[0]?.workspaceId || '',
        );
        setBridgeError('');
        return sessions;
      }

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
    bridgeHealth,
    bridgeDiscoveryMode,
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
