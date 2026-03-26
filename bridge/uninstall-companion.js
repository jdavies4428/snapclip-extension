import { uninstallLocalCompanion } from './companion.js';

try {
  const result = await uninstallLocalCompanion();
  process.stdout.write(`Uninstalled LLM Clip Companion (${result.label})\n`);
  process.stdout.write(`Removed LaunchAgent: ${result.launchAgentPath}\n`);
  process.stdout.write(`Removed App Support: ${result.baseDir}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
