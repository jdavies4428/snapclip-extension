import { getIntegrationConfig, setIntegrationConfig } from '../config';

const TEAMS_SCOPES = [
  'offline_access',
  'openid',
  'profile',
  'User.Read',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
  'ChannelMessage.Send',
].join(' ');

const SESSION_LOCK_KEY = 'snapclip.teams.refreshLock';

function randomString(length = 48): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(bytes: ArrayBuffer): string {
  const chars = Array.from(new Uint8Array(bytes), (value) => String.fromCharCode(value)).join('');
  return btoa(chars).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toBase64Url(digest);
}

function getTenantId(value: string): string {
  return value.trim() || 'common';
}

function buildTokenEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

async function exchangeToken(input: {
  tenantId: string;
  body: URLSearchParams;
}) {
  const response = await fetch(buildTokenEndpoint(input.tenantId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: input.body.toString(),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || 'Microsoft rejected the Teams authentication request.');
  }

  return payload;
}

export async function launchTeamsAuth(): Promise<void> {
  const config = await getIntegrationConfig('teams');
  if (!config.clientId) {
    throw new Error('Enter a Teams client ID before connecting.');
  }

  const tenantId = getTenantId(config.tenantId);
  const redirectUri = chrome.identity.getRedirectURL();
  const codeVerifier = randomString(64);
  const codeChallenge = await sha256(codeVerifier);
  const state = randomString(16);
  const authUrl = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_mode', 'query');
  authUrl.searchParams.set('scope', TEAMS_SCOPES);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  const callbackUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });

  if (!callbackUrl) {
    throw new Error('Teams sign-in was canceled.');
  }

  const callback = new URL(callbackUrl);
  const returnedState = callback.searchParams.get('state');
  const code = callback.searchParams.get('code');
  const oauthError = callback.searchParams.get('error_description') || callback.searchParams.get('error');
  if (oauthError) {
    throw new Error(oauthError);
  }
  if (!code || returnedState !== state) {
    throw new Error('Teams sign-in could not be verified.');
  }

  const token = await exchangeToken({
    tenantId,
    body: new URLSearchParams({
      client_id: config.clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      scope: TEAMS_SCOPES,
    }),
  });

  await setIntegrationConfig('teams', {
    tenantId,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || '',
    expiresAt: new Date(Date.now() + Math.max(0, (token.expires_in ?? 3600) - 300) * 1000).toISOString(),
  });
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getValidAccessToken(): Promise<string> {
  const config = await getIntegrationConfig('teams');
  if (!config.clientId || !config.refreshToken) {
    throw new Error('Reconnect Teams from the Integrations tab.');
  }

  if (config.accessToken && config.expiresAt && new Date(config.expiresAt).getTime() > Date.now()) {
    return config.accessToken;
  }

  const sessionResult = await chrome.storage.session.get(SESSION_LOCK_KEY);
  if (sessionResult[SESSION_LOCK_KEY]) {
    await sleep(2000);
    const refreshed = await getIntegrationConfig('teams');
    if (refreshed.accessToken && refreshed.expiresAt && new Date(refreshed.expiresAt).getTime() > Date.now()) {
      return refreshed.accessToken;
    }
  }

  await chrome.storage.session.set({
    [SESSION_LOCK_KEY]: true,
  });

  try {
    const token = await exchangeToken({
      tenantId: getTenantId(config.tenantId),
      body: new URLSearchParams({
        client_id: config.clientId,
        grant_type: 'refresh_token',
        refresh_token: config.refreshToken,
        scope: TEAMS_SCOPES,
      }),
    });

    await setIntegrationConfig('teams', {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || config.refreshToken,
      expiresAt: new Date(Date.now() + Math.max(0, (token.expires_in ?? 3600) - 300) * 1000).toISOString(),
    });

    if (!token.access_token) {
      throw new Error('Teams did not return a refreshed access token.');
    }

    return token.access_token;
  } finally {
    await chrome.storage.session.remove(SESSION_LOCK_KEY);
  }
}
