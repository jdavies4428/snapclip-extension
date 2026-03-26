import { installLocalCompanion } from './companion.js';

try {
  const result = await installLocalCompanion();
  process.stdout.write(`Installed LLM Clip Companion (${result.label})\n`);
  process.stdout.write(`LaunchAgent: ${result.launchAgentPath}\n`);
  process.stdout.write(`Run script: ${result.runScriptPath}\n`);
  process.stdout.write(`Logs: ${result.logsDir}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
