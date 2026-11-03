import '../../shared/test/git-env.ts';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../../shared/src/process.ts';

Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'test@example.invalid' });

const root = fileURLToPath(new URL('../../..', import.meta.url));
const entry = join(root, 'scripts/git/git-wt');
const tty = join(root, 'tools/shared/test/pty_driver.py');

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '');
}

let counter = 0;
export async function commit(cwd: string, subject: string): Promise<void> {
  await writeFile(join(cwd, `file-${++counter}.txt`), `${subject}\n`);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', subject);
}

// origin.git holds main plus feature/on-origin and feature/ahead. seed is a clone used to
// change origin behind the fixture's back. project is the worktree root: the main checkout
// is project/repo (normal) or project/main beside project/.bare (bare).
export type Fixture = { origin: string; seed: string; project: string; cwd: string; gum: { env: NodeJS.ProcessEnv; log: string } };

export async function fixture(t: { after: (fn: () => Promise<void>) => void }, layout: 'normal' | 'bare'): Promise<Fixture> {
  // Git reports real paths, and macOS's tmpdir is behind a symlink.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'git-wt-test-')));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const origin = join(base, 'origin.git'), seed = join(base, 'seed'), project = join(base, 'project');
  await mkdir(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(base, 'clone', '-q', origin, seed);
  git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await commit(seed, 'chore: initial');
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  for (const name of ['feature/on-origin', 'feature/ahead']) {
    git(seed, 'switch', '-q', '-c', name, 'main');
    await commit(seed, `feat: ${name}`);
    git(seed, 'push', '-q', '-u', 'origin', name);
  }
  git(seed, 'switch', '-q', 'main');
  await mkdir(project);
  let cwd: string;
  if (layout === 'normal') {
    cwd = join(project, 'repo');
    git(project, 'clone', '-q', origin, cwd);
  } else {
    // `git clone --bare` copies every branch as a local one and sets no fetch refspec.
    const bare = join(project, '.bare');
    git(project, 'clone', '-q', '--bare', origin, bare);
    cwd = join(project, 'main');
    git(bare, 'worktree', 'add', '-q', cwd, 'main');
  }
  return { origin, seed, project, cwd, gum: await fakeGum(base) };
}

// Fake gum. WT_GUM answers every confirm: yes | no | ctrl-c, or missing (gum --version fails).
// Each confirm prompt is logged as one JSON line.
async function fakeGum(base: string): Promise<{ env: NodeJS.ProcessEnv; log: string }> {
  const bin = join(base, 'gum-bin'), log = join(base, 'gum-log');
  await mkdir(bin);
  await writeFile(join(bin, 'gum'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const answer = process.env.WT_GUM || 'yes';
if (args.includes('--version')) process.exit(answer === 'missing' ? 1 : 0);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command: args[0], args }) + '\\n');
if (args[0] !== 'confirm') process.exit(3);
process.exit(answer === 'yes' ? 0 : answer === 'ctrl-c' ? 130 : 1);
`, { mode: 0o700 });
  return { env: { PATH: `${bin}:${process.env.PATH}` }, log };
}

// Without a terminal, stdout and stderr stay apart. Through the PTY driver they are merged.
export async function cli(f: Fixture, args: string[], options: { gum?: string; interactive?: boolean; cwd?: string } = {}) {
  const env = { ...process.env, ...f.gum.env, WT_GUM: options.gum ?? 'missing', NO_COLOR: '1' };
  const [command, parameters] = options.interactive ? ['python3', [tty, entry, ...args]] : [entry, args];
  return await run(command, parameters, { cwd: options.cwd ?? f.cwd, env, timeoutMs: 20_000 });
}
