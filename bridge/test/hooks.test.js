import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildClaudeHookConfig, getDefaultClaudeSettingsPath, installClaudeHookConfig } from '../hooks.js';

test('buildClaudeHookConfig produces command lifecycle hooks and authenticated HTTP tool hooks', () => {
  const config = buildClaudeHookConfig({
    baseUrl: 'http://127.0.0.1:4311/',
    token: 'snapclip-dev',
  });

  assert.deepEqual(Object.keys(config.hooks), [
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'PermissionRequest',
    'Stop',
  ]);

  assert.equal(config.hooks.SessionStart[0].hooks[0].type, 'command');
  assert.match(config.hooks.SessionStart[0].hooks[0].command, /curl -sf -X POST/);
  assert.match(config.hooks.SessionStart[0].hooks[0].command, /http:\/\/127\.0\.0\.1:4311\/hooks\/session-start/);
  assert.match(config.hooks.SessionStart[0].hooks[0].command, /X-SnapClip-Token: snapclip-dev/);

  assert.equal(config.hooks.PermissionRequest[0].hooks[0].type, 'http');
  assert.equal(config.hooks.PermissionRequest[0].hooks[0].url, 'http://127.0.0.1:4311/hooks/permission-request');
  assert.deepEqual(config.hooks.PermissionRequest[0].hooks[0].headers, {
    'X-SnapClip-Token': 'snapclip-dev',
  });
});

test('buildClaudeHookConfig rejects empty or invalid base URLs', () => {
  assert.throws(
    () =>
      buildClaudeHookConfig({
        baseUrl: '',
        token: 'snapclip-dev',
      }),
    /absolute bridge base URL/i,
  );

  assert.throws(
    () =>
      buildClaudeHookConfig({
        baseUrl: '/hooks',
        token: 'snapclip-dev',
      }),
    /valid absolute URL/i,
  );
});

test('installClaudeHookConfig merges into settings.local.json without duplicating existing bridge hooks', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapclip-hook-install-'));
  const settingsPath = join(workspaceRoot, '.claude', 'settings.local.json');
  await mkdir(join(workspaceRoot, '.claude'), { recursive: true });

  await writeFile(
    settingsPath,
    `${JSON.stringify(
      {
        disableAllHooks: false,
        hooks: {
          PostToolUse: [
            {
              matcher: 'Write',
              hooks: [
                {
                  type: 'command',
                  command: './scripts/format.sh',
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  await installClaudeHookConfig({
    cwd: workspaceRoot,
    settingsPath,
    baseUrl: 'http://127.0.0.1:4311',
    token: 'snapclip-dev',
  });

  await installClaudeHookConfig({
    cwd: workspaceRoot,
    settingsPath,
    baseUrl: 'http://127.0.0.1:4311',
    token: 'snapclip-dev',
  });

  const parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(parsed.disableAllHooks, false);
  assert.equal(parsed.hooks.PostToolUse.length, 2);
  assert.equal(
    parsed.hooks.PostToolUse.filter(
      (entry) =>
        Array.isArray(entry.hooks) &&
        entry.hooks.some((hook) => hook.type === 'http' && hook.url === 'http://127.0.0.1:4311/hooks/post-tool-use'),
    ).length,
    1,
  );
  assert.equal(
    parsed.hooks.PermissionRequest[0].hooks[0].url,
    'http://127.0.0.1:4311/hooks/permission-request',
  );
  assert.equal(
    parsed.hooks.SessionStart.filter(
      (entry) =>
        Array.isArray(entry.hooks) &&
        entry.hooks.some((hook) => hook.type === 'command' && String(hook.command).includes('/hooks/session-start')),
    ).length,
    1,
  );
});

test('installClaudeHookConfig replaces legacy SnapClip HTTP lifecycle hooks with command hooks', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapclip-hook-migrate-'));
  const settingsPath = join(workspaceRoot, '.claude', 'settings.local.json');
  await mkdir(join(workspaceRoot, '.claude'), { recursive: true });

  await writeFile(
    settingsPath,
    `${JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'http',
                  url: 'http://127.0.0.1:4311/hooks/session-start',
                  headers: {
                    'X-SnapClip-Token': 'snapclip-dev',
                  },
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  await installClaudeHookConfig({
    cwd: workspaceRoot,
    settingsPath,
    baseUrl: 'http://127.0.0.1:4311',
    token: 'snapclip-dev',
  });

  const parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(parsed.hooks.SessionStart.length, 1);
  assert.equal(parsed.hooks.SessionStart[0].hooks[0].type, 'command');
  assert.match(parsed.hooks.SessionStart[0].hooks[0].command, /\/hooks\/session-start/);
});

test('getDefaultClaudeSettingsPath targets the user Claude settings file', () => {
  assert.equal(getDefaultClaudeSettingsPath('/repo'), join(homedir(), '.claude', 'settings.local.json'));
});
