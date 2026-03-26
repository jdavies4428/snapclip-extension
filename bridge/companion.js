import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveBridgeConfig } from './config.js';

const execFileAsync = promisify(execFile);
const COMPANION_LABEL = 'dev.llmclip.bridge';

export function resolveCompanionPaths(home = homedir()) {
  const baseDir = resolve(home, 'Library', 'Application Support', 'LLM Clip Companion');
  return {
    baseDir,
    logsDir: resolve(baseDir, 'logs'),
    runScriptPath: resolve(baseDir, 'run-bridge.sh'),
    launchAgentPath: resolve(home, 'Library', 'LaunchAgents', `${COMPANION_LABEL}.plist`),
  };
}

export function renderCompanionRunScript(options) {
  const {
    repoRoot,
    nodePath,
    host,
    port,
    token,
    workspaceRoots,
    logsDir,
  } = options;

  const workspaceValue = workspaceRoots.join(',');

  return `#!/bin/zsh
set -euo pipefail

export SNAPCLIP_BRIDGE_HOST=${shellEscape(host)}
export SNAPCLIP_BRIDGE_PORT=${shellEscape(String(port))}
export SNAPCLIP_BRIDGE_TOKEN=${shellEscape(token)}
export SNAPCLIP_BRIDGE_WORKSPACES=${shellEscape(workspaceValue)}

mkdir -p ${shellEscape(logsDir)}
cd ${shellEscape(repoRoot)}
exec ${shellEscape(nodePath)} ${shellEscape(resolve(repoRoot, 'bridge', 'index.js'))} >> ${shellEscape(
    resolve(logsDir, 'stdout.log'),
  )} 2>> ${shellEscape(resolve(logsDir, 'stderr.log'))}
`;
}

export function renderLaunchAgentPlist(options) {
  const {
    runScriptPath,
    workingDirectory,
  } = options;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${COMPANION_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/zsh</string>
      <string>${runScriptPath}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${workingDirectory}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
  </dict>
</plist>
`;
}

export async function installLocalCompanion(options = {}) {
  assertDarwin();

  const config = resolveBridgeConfig(options);
  const repoRoot = resolve(options.repoRoot ?? config.cwd);
  const nodePath = resolve(options.nodePath ?? process.execPath);
  const paths = resolveCompanionPaths(options.homeDir);

  await mkdir(paths.baseDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  await mkdir(dirname(paths.launchAgentPath), { recursive: true });

  await writeFile(
    paths.runScriptPath,
    renderCompanionRunScript({
      repoRoot,
      nodePath,
      host: config.host,
      port: config.port,
      token: config.token,
      workspaceRoots: config.workspaceRoots,
      logsDir: paths.logsDir,
    }),
    'utf8',
  );
  await chmod(paths.runScriptPath, 0o755);

  await writeFile(
    paths.launchAgentPath,
    renderLaunchAgentPlist({
      runScriptPath: paths.runScriptPath,
      workingDirectory: repoRoot,
    }),
    'utf8',
  );

  await safeLaunchctl(['unload', '-w', paths.launchAgentPath]);
  await execFileAsync('launchctl', ['load', '-w', paths.launchAgentPath]);

  return {
    label: COMPANION_LABEL,
    launchAgentPath: paths.launchAgentPath,
    runScriptPath: paths.runScriptPath,
    logsDir: paths.logsDir,
  };
}

export async function startLocalCompanion(options = {}) {
  assertDarwin();
  const paths = resolveCompanionPaths(options.homeDir);
  await execFileAsync('launchctl', ['load', '-w', paths.launchAgentPath]);
  await execFileAsync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${COMPANION_LABEL}`]);
  return {
    label: COMPANION_LABEL,
    launchAgentPath: paths.launchAgentPath,
  };
}

export async function stopLocalCompanion(options = {}) {
  assertDarwin();
  const paths = resolveCompanionPaths(options.homeDir);
  await safeLaunchctl(['bootout', `gui/${process.getuid()}/${COMPANION_LABEL}`]);
  await safeLaunchctl(['unload', '-w', paths.launchAgentPath]);
  return {
    label: COMPANION_LABEL,
    launchAgentPath: paths.launchAgentPath,
  };
}

export async function uninstallLocalCompanion(options = {}) {
  assertDarwin();
  const paths = resolveCompanionPaths(options.homeDir);
  await stopLocalCompanion(options);
  await rm(paths.launchAgentPath, { force: true });
  await rm(paths.baseDir, { recursive: true, force: true });
  return {
    label: COMPANION_LABEL,
    launchAgentPath: paths.launchAgentPath,
    baseDir: paths.baseDir,
  };
}

async function safeLaunchctl(args) {
  try {
    await execFileAsync('launchctl', args);
  } catch {
    // Ignore launchctl failures when the target is not yet loaded.
  }
}

function assertDarwin() {
  if (process.platform !== 'darwin') {
    throw new Error('Local companion install scripts currently support macOS only.');
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}
