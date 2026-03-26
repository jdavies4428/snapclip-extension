import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';

function resolveClaudeCommand() {
  const configuredBinary = String(process.env.SNAPCLIP_CLAUDE_BIN ?? '').trim();
  if (configuredBinary) {
    return configuredBinary;
  }

  const knownPaths = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];

  const discoveredPath = knownPaths.find((candidate) => existsSync(candidate));
  return discoveredPath || 'claude';
}

export function buildClaudeResumePrompt(bundlePath, prompt, cwd) {
  const readablePath = relative(cwd, bundlePath) || bundlePath;

  return [
    `A new LLM Clip incident bundle was written to ${readablePath}.`,
    'Read these files from that folder before responding:',
    '- prompt-claude.md',
    '- context.json',
    '- annotations.json',
    '- screenshot.png',
    '- annotated.png',
    '',
    'Then continue with the incident request below:',
    '',
    prompt.trim(),
  ].join('\n');
}

export async function runClaudeResume({ sessionId, prompt, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveClaudeCommand(), ['-r', sessionId, '-p', prompt], {
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
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
        return;
      }

      const error = new Error(stderr.trim() || stdout.trim() || `Claude CLI exited with code ${code}.`);
      error.stdout = stdout.trim();
      error.stderr = stderr.trim();
      error.exitCode = code;
      reject(error);
    });
  });
}

export async function probeClaudeCli(options = {}) {
  const timeoutMs = options.timeoutMs ?? 1200;
  return new Promise((resolve) => {
    const child = spawn(resolveClaudeCommand(), ['--version'], {
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

    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        cliAvailable: false,
        cliVersion: null,
      });
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timeoutId);
      resolve({
        cliAvailable: false,
        cliVersion: null,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve({
          cliAvailable: true,
          cliVersion: stdout.trim() || stderr.trim() || 'unknown',
        });
        return;
      }

      resolve({
        cliAvailable: false,
        cliVersion: null,
      });
    });
  });
}
