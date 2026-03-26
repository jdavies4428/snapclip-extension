export const STORAGE_KEYS = {
  legacyClipSession: 'snapclip.clipSession',
  clipSessionIndex: 'snapclip.clipSessionIndex',
  lastLaunchError: 'snapclip.lastLaunchError',
  lastCapturedClipId: 'snapclip.lastCapturedClipId',
  bridgeBaseUrl: 'snapclip.bridge.baseUrl',
  bridgeToken: 'snapclip.bridge.token',
  bridgeSelectedWorkspaceId: 'snapclip.bridge.selectedWorkspaceId',
  bridgeSelectedSessionId: 'snapclip.bridge.selectedSessionId',
} as const;

export function getClipStorageKey(clipId: string): string {
  return `snapclip.clip.${clipId}`;
}

export function isClipStorageKey(key: string): boolean {
  return key.startsWith('snapclip.clip.');
}
