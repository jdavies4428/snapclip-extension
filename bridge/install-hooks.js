import { resolveBridgeConfig } from './config.js';
import { installClaudeHookConfig } from './hooks.js';

const args = parseArgs(process.argv.slice(2));
const config = resolveBridgeConfig();

try {
  const result = await installClaudeHookConfig({
    cwd: config.cwd,
    settingsPath: args.settingsPath,
    baseUrl: args.baseUrl ?? `http://${config.host}:${config.port}`,
    token: args.token ?? config.token,
  });

  process.stdout.write(`Installed Claude Code hook config at ${result.settingsPath}\n`);
  process.stdout.write(`Events: ${result.installedEvents.join(', ')}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    settingsPath: '',
    baseUrl: '',
    token: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const nextValue = argv[index + 1];

    if (value === '--settings' && nextValue) {
      args.settingsPath = nextValue;
      index += 1;
      continue;
    }

    if (value === '--base-url' && nextValue) {
      args.baseUrl = nextValue;
      index += 1;
      continue;
    }

    if (value === '--token' && nextValue) {
      args.token = nextValue;
      index += 1;
    }
  }

  return args;
}
