// Process helpers for the Windows half. Plain Node APIs: this file ships to `npx` users.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Swallow stderr on success (it is still shown when the command fails). */
  quiet?: boolean;
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${command} exited ${code ?? 'by signal'}\n${stderr.slice(-4000)}${stdout ? `\n${stdout.slice(-2000)}` : ''}`);
  }
}

/** Run to completion and return stdout. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      env: { ...process.env, ...opts.env },
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) reject(new CommandError([cmd, ...args].join(' '), code, stdout, stderr));
      else {
        if (!opts.quiet && stderr.trim()) process.stderr.write(stderr);
        resolve(stdout);
      }
    });
  });
}

/** Run with output streamed to this terminal. */
export function runInherit(cmd: string, args: string[], opts: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      env: { ...process.env, ...opts.env },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new CommandError([cmd, ...args].join(' '), code, '', ''))));
  });
}

/** Does the command exit 0? */
export async function succeeds(cmd: string, args: string[], opts: RunOptions = {}): Promise<boolean> {
  try {
    await run(cmd, args, { ...opts, quiet: true });
    return true;
  } catch {
    return false;
  }
}

/** First `<name>.exe` on PATH (Windows), or undefined. */
export function which(name: string): string | undefined {
  for (const dir of (process.env['PATH'] ?? '').split(';')) {
    if (!dir) continue;
    for (const ext of ['.exe', '.cmd', '']) {
      const f = join(dir, name + ext);
      if (existsSync(f)) return f;
    }
  }
  return undefined;
}

export function step(msg: string): void {
  console.log(`\x1b[36m==\x1b[0m ${msg}`);
}
