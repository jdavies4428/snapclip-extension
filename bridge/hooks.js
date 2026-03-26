import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const CLAUDE_HOOK_ENDPOINTS = {
  SessionStart: '/hooks/session-start',
  SessionEnd: '/hooks/session-end',
  UserPromptSubmit: '/hooks/user-prompt-submit',
  PreToolUse: '/hooks/pre-tool-use',
  PostToolUse: '/hooks/post-tool-use',
  PostToolUseFailure: '/hooks/post-tool-use-failure',
  PermissionRequest: '/hooks/permission-request',
  Stop: '/hooks/stop',
};

const REQUIRED_DISCOVERY_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit'];
const COMMAND_LIFECYCLE_EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop']);

export function getDefaultClaudeSettingsPath(cwd = process.cwd()) {
  return resolve(homedir(), '.claude', 'settings.local.json');
}

export function buildClaudeHookConfig({ baseUrl, token }) {
  const normalizedBaseUrl = normalizeHookBaseUrl(baseUrl);
  const normalizedToken = String(token ?? '').trim();

  return {
    hooks: Object.fromEntries(
      Object.entries(CLAUDE_HOOK_ENDPOINTS).map(([eventName, pathname]) => [
        eventName,
        [
          {
            hooks: [
              buildHookDefinition({
                eventName,
                pathname,
                baseUrl: normalizedBaseUrl,
                token: normalizedToken,
              }),
            ],
          },
        ],
      ]),
    ),
  };
}

function buildHookDefinition({ eventName, pathname, baseUrl, token }) {
  const url = `${baseUrl}${pathname}`;
  if (COMMAND_LIFECYCLE_EVENTS.has(eventName)) {
    return {
      type: 'command',
      command:
        `curl -sf -X POST ${shellSingleQuote(url)}` +
        ` -H 'Content-Type: application/json'` +
        ` -H ${shellSingleQuote(`X-SnapClip-Token: ${token}`)}` +
        ' --data-binary @- || true',
    };
  }

  return {
    type: 'http',
    url,
    headers: {
      'X-SnapClip-Token': token,
    },
  };
}

function normalizeHookBaseUrl(baseUrl) {
  const normalized = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!normalized) {
    throw new Error('Claude hook installation requires an absolute bridge base URL.');
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Claude hook installation requires a valid absolute URL. Received: ${normalized}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Claude hook installation requires an http(s) bridge URL. Received: ${normalized}`);
  }

  return normalized;
}

export async function installClaudeHookConfig({
  settingsPath,
  baseUrl,
  token,
  cwd = process.cwd(),
}) {
  const resolvedSettingsPath = resolve(settingsPath || getDefaultClaudeSettingsPath(cwd));
  const existing = await readSettingsFile(resolvedSettingsPath);
  const additions = buildClaudeHookConfig({ baseUrl, token });
  const merged = mergeHookSettings(existing, additions);

  await mkdir(dirname(resolvedSettingsPath), { recursive: true });
  await writeFile(resolvedSettingsPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

  return {
    settingsPath: resolvedSettingsPath,
    hookConfig: additions,
    installedEvents: Object.keys(additions.hooks),
  };
}

export async function inspectClaudeHookConfig({
  cwd = process.cwd(),
  settingsPath,
  baseUrl,
  token,
}) {
  const resolvedSettingsPath = resolve(settingsPath || getDefaultClaudeSettingsPath(cwd));
  const existing = await readSettingsFile(resolvedSettingsPath);
  const expected = buildClaudeHookConfig({ baseUrl, token });
  const installedEvents = Object.entries(expected.hooks)
    .filter(([eventName, entries]) => hasInstalledHookEntries(existing.hooks?.[eventName], entries))
    .map(([eventName]) => eventName);

  return {
    settingsPath: resolvedSettingsPath,
    installedEvents,
    hookInstalled: REQUIRED_DISCOVERY_EVENTS.every((eventName) => installedEvents.includes(eventName)),
  };
}

async function readSettingsFile(settingsPath) {
  try {
    const raw = await readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {};
    }

    throw error;
  }
}

function mergeHookSettings(existing, additions) {
  const next = {
    ...existing,
    hooks: isPlainObject(existing.hooks) ? { ...existing.hooks } : {},
  };

  for (const [eventName, entries] of Object.entries(additions.hooks ?? {})) {
    const currentEntries = Array.isArray(next.hooks[eventName]) ? next.hooks[eventName] : [];
    next.hooks[eventName] = upsertHookEntries(currentEntries, entries);
  }

  return next;
}

function upsertHookEntries(currentEntries, additions) {
  const nextEntries = currentEntries
    .map((entry) =>
      isPlainObject(entry) ? { ...entry, hooks: Array.isArray(entry.hooks) ? [...entry.hooks] : [] } : entry,
    )
    .filter((entry) => !entryContainsManagedSnapclipHook(entry));

  for (const addition of additions) {
    const nextHook = addition.hooks?.[0];
    if (!isPlainObject(nextHook)) {
      continue;
    }

    nextEntries.push(addition);
  }

  return nextEntries;
}

function hasInstalledHookEntries(currentEntries, additions) {
  if (!Array.isArray(currentEntries) || !Array.isArray(additions)) {
    return false;
  }

  return additions.every((addition) => {
    const nextHook = addition.hooks?.[0];
    if (!isPlainObject(nextHook)) {
      return false;
    }

    return currentEntries.some(
      (entry) =>
        isPlainObject(entry) &&
        Array.isArray(entry.hooks) &&
        entry.hooks.some(
          (hook) => isManagedHookEquivalent(hook, nextHook),
        ),
    );
  });
}

function isManagedHookEquivalent(currentHook, expectedHook) {
  if (!isPlainObject(currentHook) || !isPlainObject(expectedHook)) {
    return false;
  }

  if (currentHook.type === 'http' && expectedHook.type === 'http') {
    return typeof currentHook.url === 'string' && typeof expectedHook.url === 'string' && urlsEquivalent(currentHook.url, expectedHook.url);
  }

  if (currentHook.type === 'command' && expectedHook.type === 'command') {
    return typeof currentHook.command === 'string' && currentHook.command === expectedHook.command;
  }

  return false;
}

function entryContainsManagedSnapclipHook(entry) {
  if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) {
    return false;
  }

  return entry.hooks.some((hook) => isManagedSnapclipHook(hook));
}

function isManagedSnapclipHook(hook) {
  if (!isPlainObject(hook)) {
    return false;
  }

  if (hook.type === 'http' && typeof hook.url === 'string') {
    return isSnapclipHookUrl(hook.url);
  }

  if (hook.type === 'command' && typeof hook.command === 'string') {
    return hook.command.includes('/hooks/session-start') ||
      hook.command.includes('/hooks/session-end') ||
      hook.command.includes('/hooks/user-prompt-submit') ||
      hook.command.includes('/hooks/pre-tool-use') ||
      hook.command.includes('/hooks/post-tool-use') ||
      hook.command.includes('/hooks/post-tool-use-failure') ||
      hook.command.includes('/hooks/permission-request') ||
      hook.command.includes('/hooks/stop');
  }

  return false;
}

function isSnapclipHookUrl(value) {
  if (value.startsWith('/hooks/')) {
    return true;
  }

  try {
    const parsed = new URL(value);
    return parsed.pathname.startsWith('/hooks/');
  } catch {
    return false;
  }
}

function urlsEquivalent(left, right) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.protocol === rightUrl.protocol &&
      normalizeLoopbackHost(leftUrl.hostname) === normalizeLoopbackHost(rightUrl.hostname) &&
      normalizePort(leftUrl) === normalizePort(rightUrl) &&
      leftUrl.pathname === rightUrl.pathname
    );
  } catch {
    return left === right;
  }
}

function normalizeLoopbackHost(hostname) {
  return hostname === 'localhost' ? '127.0.0.1' : hostname;
}

function normalizePort(url) {
  if (url.port) {
    return url.port;
  }

  return url.protocol === 'https:' ? '443' : '80';
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
