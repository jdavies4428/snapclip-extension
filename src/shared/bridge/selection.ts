import type { BridgeSession, BridgeWorkspace } from './client';

export function pickWorkspaceId(workspaces: BridgeWorkspace[], currentValue: string): string {
  if (currentValue && workspaces.some((workspace) => workspace.id === currentValue)) {
    return currentValue;
  }

  const withSessions = workspaces.find((workspace) => workspace.sessionCount > 0);
  return withSessions?.id ?? workspaces[0]?.id ?? '';
}

export function pickSessionId(sessions: BridgeSession[], currentValue: string): string {
  if (currentValue && sessions.some((session) => session.id === currentValue)) {
    return currentValue;
  }

  return sessions.length === 1 ? sessions[0]?.id ?? '' : '';
}
