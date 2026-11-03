import '../../shared/test/git-env.ts';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../../shared/src/process.ts';

Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
});

const root = fileURLToPath(new URL('../../..', import.meta.url));
const entry = join(root, 'scripts/git/git-live');

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '');
}

let counter = 0;
export async function commit(cwd: string, subject: string): Promise<void> {
  await writeFile(join(cwd, `file-${++counter}.txt`), `${subject}\n`);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', subject);
}

// origin.git has main and live at the same commit. seed is a clone that changes origin behind
// the back of cwd, the clone git live runs in.
export type Fixture = { origin: string; seed: string; cwd: string; base: string; log: string };

export async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<Fixture> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'git-live-test-')));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  const origin = join(base, 'origin.git'),
    seed = join(base, 'seed'),
    cwd = join(base, 'repo');
  await mkdir(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(base, 'clone', '-q', origin, seed);
  git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await commit(seed, 'chore: initial');
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  git(seed, 'push', '-q', 'origin', 'main:live');
  git(base, 'clone', '-q', origin, cwd);
  return { origin, seed, cwd, base, log: join(base, 'gh-log') };
}

// Adds commits to origin's live through the seed clone.
export async function pushToLive(f: Fixture, ...subjects: string[]): Promise<void> {
  git(f.seed, 'fetch', '-q', 'origin');
  git(f.seed, 'switch', '-q', '-C', 'live', 'origin/live');
  for (const subject of subjects) await commit(f.seed, subject);
  git(f.seed, 'push', '-q', 'origin', 'live');
  git(f.seed, 'switch', '-q', 'main');
}

// Fake gh. GH_AUTH=fail fails gh auth status; GH_OPEN holds the JSON gh pr list prints;
// GH_MERGE=fail fails gh pr merge. Every call is logged as one JSON line of its arguments.
async function fakeGh(base: string, log: string): Promise<string> {
  const bin = join(base, 'gh-bin');
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('gh version 2.0.0 (fake)'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const command = args.slice(0, 2).join(' ');
if (command === 'auth status') process.exit(process.env.GH_AUTH === 'fail' ? 1 : 0);
if (command === 'pr list') { console.log(process.env.GH_OPEN || '[]'); process.exit(0); }
if (command === 'pr create') { console.log('https://github.com/owner/repo/pull/7'); process.exit(0); }
if (command === 'pr edit') process.exit(0);
if (command === 'pr merge') {
  if (process.env.GH_MERGE === 'fail') { console.error('auto-merge is not allowed for this repository'); process.exit(1); }
  process.exit(0);
}
process.exit(3);
`,
    { mode: 0o700 },
  );
  return bin;
}

export async function cli(f: Fixture, args: string[], env: NodeJS.ProcessEnv = {}) {
  const bin = await fakeGh(f.base, f.log);
  return await run(entry, args, {
    cwd: f.cwd,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NO_COLOR: '1', ...env },
    timeoutMs: 20_000,
  });
}

export const ghCalls = async (f: Fixture): Promise<string[][]> =>
  existsSync(f.log)
    ? (await readFile(f.log, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as string[])
    : [];
