import { stopLocalCompanion } from './companion.js';

try {
  const result = await stopLocalCompanion();
  process.stdout.write(`Stopped LLM Clip Companion (${result.label})\n`);
  process.stdout.write(`LaunchAgent: ${result.launchAgentPath}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
