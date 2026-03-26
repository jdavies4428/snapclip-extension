import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function resolveBridgeConfig(overrides = {}) {
  const env = overrides.env ?? process.env;
  const cwd = resolve(overrides.cwd ?? process.cwd());
  const claudeStateRoot = resolve(
    overrides.claudeStateRoot ?? env.SNAPCLIP_CLAUDE_STATE_ROOT ?? resolve(homedir(), '.claude'),
  );
  const codexStateRoot = resolve(
    overrides.codexStateRoot ?? env.SNAPCLIP_CODEX_STATE_ROOT ?? resolve(homedir(), '.codex'),
  );

  const workspaceRoots = resolveWorkspaceRoots(env.SNAPCLIP_BRIDGE_WORKSPACES, cwd);

  return {
    host: overrides.host ?? env.SNAPCLIP_BRIDGE_HOST ?? '127.0.0.1',
    port: Number(overrides.port ?? env.SNAPCLIP_BRIDGE_PORT ?? 4311),
    token: String(overrides.token ?? env.SNAPCLIP_BRIDGE_TOKEN ?? 'snapclip-dev'),
    workspaceRoots,
    claudeStateRoot,
    codexStateRoot,
    claudeProjectsRoot: resolve(overrides.claudeProjectsRoot ?? env.SNAPCLIP_CLAUDE_PROJECTS_ROOT ?? resolve(homedir(), '.claude', 'projects')),
    cwd,
  };
}

function resolveWorkspaceRoots(rawValue, cwd) {
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return [cwd];
  }

  const values = rawValue
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));

  return values.length ? values : [cwd];
}
