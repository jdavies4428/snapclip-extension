import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildClaudeHookConfig, installClaudeHookConfig } from '../hooks.js';

test('buildClaudeHookConfig produces authenticated HTTP hooks for each supported event', () => {
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

  assert.equal(config.hooks.PermissionRequest[0].hooks[0].type, 'http');
  assert.equal(config.hooks.PermissionRequest[0].hooks[0].url, 'http://127.0.0.1:4311/hooks/permission-request');
  assert.deepEqual(config.hooks.PermissionRequest[0].hooks[0].headers, {
    'X-SnapClip-Token': 'snapclip-dev',
  });
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
});
