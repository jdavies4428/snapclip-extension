import { spawn } from 'node:child_process';
import { relative } from 'node:path';

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
    const child = spawn('claude', ['-r', sessionId, '-p', prompt], {
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
