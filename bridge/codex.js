import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

function resolveCodexCommand() {
  const configuredBinary = String(process.env.SNAPCLIP_CODEX_BIN ?? '').trim();
  if (configuredBinary) {
    return configuredBinary;
  }

  const knownPaths = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ];

  const discoveredPath = knownPaths.find((candidate) => existsSync(candidate));
  return discoveredPath || 'codex';
}

export function buildCodexResumePrompt(bundlePath, prompt, cwd) {
  const readablePath = relative(cwd, bundlePath) || bundlePath;

  return [
    `A new LLM Clip incident bundle was written to ${readablePath}.`,
    'Open `prompt-codex.md` from that folder first, then follow the file instructions inside that prompt.',
    'The bundle may include an ordered `clips/` directory for multi-image sends.',
    'Then continue with the incident request below:',
    '',
    prompt.trim(),
  ].join('\n');
}

export async function runCodexResume({ sessionId, prompt, cwd, imagePaths = [] }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = ['resume', sessionId, prompt];
    imagePaths
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .forEach((imagePath) => {
        args.push('-i', resolve(cwd, imagePath));
      });

    const child = spawn(resolveCodexCommand(), args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      rejectPromise(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ stdout: stdout.trim(), stderr: stderr.trim(), code });
        return;
      }

      const error = new Error(stderr.trim() || stdout.trim() || `Codex CLI exited with code ${code}.`);
      error.stdout = stdout.trim();
      error.stderr = stderr.trim();
      error.exitCode = code;
      rejectPromise(error);
    });
  });
}
