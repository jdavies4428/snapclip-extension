import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

export function getDefaultClaudeSettingsPath(cwd) {
  return resolve(cwd, '.claude', 'settings.local.json');
}

export function buildClaudeHookConfig({ baseUrl, token }) {
  const normalizedBaseUrl = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  const headers = {
    'X-SnapClip-Token': String(token ?? '').trim(),
  };

  return {
    hooks: Object.fromEntries(
      Object.entries(CLAUDE_HOOK_ENDPOINTS).map(([eventName, pathname]) => [
        eventName,
        [
          {
            hooks: [
              {
                type: 'http',
                url: `${normalizedBaseUrl}${pathname}`,
                headers,
              },
            ],
          },
        ],
      ]),
    ),
  };
}

export async function installClaudeHookConfig({
  settingsPath,
  baseUrl,
  token,
  cwd = process.cwd(),
}) {
  const resolvedSettingsPath = resolve(settingsPath ?? getDefaultClaudeSettingsPath(cwd));
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
  const resolvedSettingsPath = resolve(settingsPath ?? getDefaultClaudeSettingsPath(cwd));
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
  const nextEntries = currentEntries.map((entry) =>
    isPlainObject(entry) ? { ...entry, hooks: Array.isArray(entry.hooks) ? [...entry.hooks] : [] } : entry,
  );

  for (const addition of additions) {
    const nextHook = addition.hooks?.[0];
    if (!isPlainObject(nextHook) || typeof nextHook.url !== 'string') {
      continue;
    }

    const existingEntry = nextEntries.find(
      (entry) =>
        isPlainObject(entry) &&
        Array.isArray(entry.hooks) &&
        entry.hooks.some(
          (hook) => isPlainObject(hook) && hook.type === 'http' && typeof hook.url === 'string' && hook.url === nextHook.url,
        ),
    );

    if (existingEntry && Array.isArray(existingEntry.hooks)) {
      existingEntry.hooks = existingEntry.hooks.map((hook) => {
        if (!isPlainObject(hook) || hook.type !== 'http' || hook.url !== nextHook.url) {
          return hook;
        }

        return {
          ...hook,
          ...nextHook,
          headers: {
            ...(isPlainObject(hook.headers) ? hook.headers : {}),
            ...(isPlainObject(nextHook.headers) ? nextHook.headers : {}),
          },
        };
      });
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
    if (!isPlainObject(nextHook) || typeof nextHook.url !== 'string') {
      return false;
    }

    return currentEntries.some(
      (entry) =>
        isPlainObject(entry) &&
        Array.isArray(entry.hooks) &&
        entry.hooks.some(
          (hook) =>
            isPlainObject(hook) &&
            hook.type === 'http' &&
            typeof hook.url === 'string' &&
            urlsEquivalent(hook.url, nextHook.url),
        ),
    );
  });
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
