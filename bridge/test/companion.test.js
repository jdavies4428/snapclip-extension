import assert from 'node:assert/strict';
import test from 'node:test';

import { renderCompanionRunScript, renderLaunchAgentPlist, resolveCompanionPaths } from '../companion.js';

test('resolveCompanionPaths uses the expected macOS locations', () => {
  const paths = resolveCompanionPaths('/Users/tester');
  assert.equal(paths.baseDir, '/Users/tester/Library/Application Support/LLM Clip Companion');
  assert.equal(paths.launchAgentPath, '/Users/tester/Library/LaunchAgents/dev.llmclip.bridge.plist');
});

test('renderCompanionRunScript includes bridge env and entrypoint', () => {
  const script = renderCompanionRunScript({
    repoRoot: '/repo',
    nodePath: '/usr/local/bin/node',
    host: '127.0.0.1',
    port: 4311,
    token: 'snapclip-dev',
    workspaceRoots: ['/repo', '/tmp/ws'],
    logsDir: '/logs',
  });

  assert.match(script, /SNAPCLIP_BRIDGE_HOST='127\.0\.0\.1'/);
  assert.match(script, /SNAPCLIP_BRIDGE_WORKSPACES='\/repo,\/tmp\/ws'/);
  assert.match(script, /bridge\/index\.js/);
});

test('renderLaunchAgentPlist points launchd at the run script', () => {
  const plist = renderLaunchAgentPlist({
    runScriptPath: '/Users/tester/Library/Application Support/LLM Clip Companion/run-bridge.sh',
    workingDirectory: '/repo',
  });

  assert.match(plist, /dev\.llmclip\.bridge/);
  assert.match(plist, /run-bridge\.sh/);
  assert.match(plist, /<key>RunAtLoad<\/key>/);
});
