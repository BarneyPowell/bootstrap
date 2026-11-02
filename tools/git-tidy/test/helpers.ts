import '../../shared/test/git-env.ts';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'test@example.invalid' });

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '');
}

let counter = 0;
export async function commit(cwd: string, subject: string): Promise<void> {
  await writeFile(join(cwd, `file-${++counter}.txt`), `${subject}\n`);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', subject);
}

export type Fixture = { root: string; origin: string; work: string; worktree: string };

// A bare origin and a clone holding one branch per case the scan has to judge:
//   merged, gone           candidates
//   ahead, gone-unmerged   kept: local commits not in origin/main
//   in-worktree, current   kept: checked out
//   old-local, old-pushed  stale: no activity for 200 days, not merged
//   wip, local-only, tracks-main, old-recreated   ignored (old-recreated has an
//                          old tip but was created today, so it is not stale)
export async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'git-tidy-test-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const origin = join(root, 'origin.git'), work = join(root, 'work'), worktree = join(root, 'wt');
  await mkdir(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(root, 'clone', '-q', origin, work);
  git(work, 'config', 'commit.gpgSign', 'false');
  git(work, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await commit(work, 'chore: initial');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  git(work, 'remote', 'set-head', 'origin', 'main');

  const branch = async (name: string, merge: boolean) => {
    git(work, 'switch', '-q', '-c', name, 'main');
    await commit(work, `feat: ${name} work`);
    git(work, 'push', '-q', '-u', 'origin', name);
    git(work, 'switch', '-q', 'main');
    if (merge) { git(work, 'merge', '-q', '--no-ff', '-m', `Merge ${name}`, name); git(work, 'push', '-q', 'origin', 'main'); }
  };
  await branch('merged', true);
  await branch('gone', true);
  git(work, 'push', '-q', 'origin', '--delete', 'gone');
  await branch('gone-unmerged', false);
  git(work, 'push', '-q', 'origin', '--delete', 'gone-unmerged');
  await branch('ahead', true);
  git(work, 'switch', '-q', 'ahead');
  await commit(work, 'feat: unpushed');
  git(work, 'switch', '-q', 'main');
  await branch('in-worktree', true);
  git(work, 'worktree', 'add', '-q', worktree, 'in-worktree');
  await branch('wip', false);
  git(work, 'branch', '-q', 'local-only', 'main');
  git(work, 'branch', '-q', '--track', 'tracks-main', 'origin/main');
  // Commits and reflog entries take their date from GIT_COMMITTER_DATE.
  const old = `${Math.floor(Date.now() / 1000) - 200 * 86_400} +0000`;
  Object.assign(process.env, { GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old });
  try {
    git(work, 'switch', '-q', '-c', 'old-local', 'main');
    await commit(work, 'feat: abandoned experiment');
    await commit(work, 'feat: more abandoned work');
    git(work, 'switch', '-q', '-c', 'old-pushed', 'main');
    await commit(work, 'feat: pushed but never merged');
    git(work, 'push', '-q', '-u', 'origin', 'old-pushed');
    git(work, 'switch', '-q', 'main');
  } finally {
    delete process.env.GIT_COMMITTER_DATE;
    delete process.env.GIT_AUTHOR_DATE;
  }
  git(work, 'branch', '-q', 'old-recreated', 'old-pushed');
  await branch('current', true);
  git(work, 'switch', '-q', 'current');
  return { root, origin, work, worktree };
}

// Fake gum. TIDY_GUM lists one step per prompt, in order:
//   choose: all | none | esc | ctrl-c | broken | pick:<value>+<value>
//   confirm: yes | no | ctrl-c
//   missing (gum --version fails)
// style and table echo their text so assertions can read the rendered output.
export async function fakeGum(root: string): Promise<{ env: NodeJS.ProcessEnv; log: string }> {
  const bin = join(root, 'gum-bin');
  await mkdir(bin, { recursive: true });
  const log = join(root, 'gum-log'), step = join(root, 'gum-step');
  await writeFile(join(bin, 'gum'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const script = (process.env.TIDY_GUM || 'all,yes').split(',');
if (args.includes('--version')) process.exit(script[0] === 'missing' ? 1 : 0);
if (args[0] === 'style') { console.log(args.at(-1)); process.exit(0); }
if (args[0] === 'table') { process.stdin.pipe(process.stdout); return; }
const index = fs.existsSync(${JSON.stringify(step)}) ? Number(fs.readFileSync(${JSON.stringify(step)}, 'utf8')) : 0;
fs.writeFileSync(${JSON.stringify(step)}, String(index + 1));
const options = args.slice(args.indexOf('--') + 1);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command: args[0], args, options }) + '\\n');
const choice = script[Math.min(index, script.length - 1)];
if (choice === 'esc' || choice === 'no') process.exit(1);
if (choice === 'ctrl-c') process.exit(130);
if (choice === 'broken') process.exit(2);
if (args[0] === 'confirm') process.exit(choice === 'yes' ? 0 : 3);
const values = options.map(option => option.split('\\t').at(-1));
const picked = choice === 'all' ? values : choice === 'none' ? [] : choice.startsWith('pick:') ? choice.slice(5).split('+') : null;
if (!picked) process.exit(3);
for (const value of picked) console.log(value);
`, { mode: 0o700 });
  return { env: { PATH: `${bin}:${process.env.PATH}` }, log };
}
