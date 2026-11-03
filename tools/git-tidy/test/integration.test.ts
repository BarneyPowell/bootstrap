import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../shared/src/process.ts';
import { commit, fakeGum, fixture, git } from './helpers.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const entry = join(root, 'scripts/git/git-tidy');
const tty = join(root, 'tools/shared/test/pty_driver.py');

async function cli(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, interactive = true) {
  const [command, parameters] = interactive ? ['python3', [tty, entry, ...args]] : [entry, args];
  return await run(command, parameters, { cwd, env: { ...process.env, ...env }, timeoutMs: 20_000 });
}

const branches = (cwd: string) =>
  git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
const remoteBranches = (origin: string) =>
  git(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
const prompts = async (log: string) =>
  (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));

test('--dry-run lists candidates without a terminal or gum and changes nothing', async t => {
  const { work, origin } = await fixture(t);
  const before = [branches(work), remoteBranches(origin)];
  const result = await cli(work, ['--dry-run'], { PATH: `/nonexistent:${process.env.PATH}` }, false);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^gone\s+gone\s/m);
  assert.match(result.stdout, /^merged\s+merged\s+origin\/merged/m);
  assert.match(result.stdout, /^kept\s+ahead\s+has commits not in origin\/main$/m);
  assert.match(result.stdout, /^stale\s+old-local\s+local only/m);
  assert.deepEqual([branches(work), remoteBranches(origin)], before);
});

test('needs a terminal unless --dry-run', async t => {
  const { work } = await fixture(t);
  const result = await cli(work, [], {}, false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /interactive terminal.*--dry-run/);
});

test('missing gum points at make ensure-gum and deletes nothing', async t => {
  const { root: dir, work } = await fixture(t);
  const gum = await fakeGum(dir);
  const result = await cli(work, ['--no-fetch'], { ...gum.env, TIDY_GUM: 'missing' });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /make ensure-gum/);
  assert.ok(branches(work).includes('merged'));
});

test('confirming deletes the selected local branches only; remote step can be skipped', async t => {
  const { root: dir, work, origin } = await fixture(t);
  const gum = await fakeGum(dir);
  const result = await cli(work, [], { ...gum.env, TIDY_GUM: 'pick:merged,yes,none' });
  assert.equal(result.code, 0, result.stdout);
  assert.ok(!branches(work).includes('merged'));
  assert.ok(branches(work).includes('gone'));
  assert.ok(remoteBranches(origin).includes('merged'));
  assert.equal(git(work, 'config', 'list').includes('branch.merged.'), false);
  assert.match(result.stdout, /Deleted 1 local · 0 on origin/);
  const [choose, confirm, remote] = await prompts(gum.log);
  assert.deepEqual(
    choose.options.map((option: string) => option.split('\t')[1]),
    ['gone', 'merged'],
  );
  assert.ok(choose.args.includes('--selected=*'));
  assert.equal(confirm.command, 'confirm');
  assert.ok(confirm.args.includes('Delete 1 local branch?'));
  // Remote deletion starts with nothing selected and only offers merged upstreams.
  assert.ok(remote.args.includes('--selected='));
  assert.deepEqual(remote.options, ['origin/merged\tmerged']);
});

test('the remote step deletes chosen merged branches on the remote', async t => {
  const { root: dir, work, origin } = await fixture(t);
  const gum = await fakeGum(dir);
  const result = await cli(work, [], { ...gum.env, TIDY_GUM: 'all,yes,all,yes,none' });
  assert.equal(result.code, 0, result.stdout);
  assert.ok(!branches(work).includes('merged') && !branches(work).includes('gone'));
  assert.ok(!remoteBranches(origin).includes('merged'));
  assert.ok(remoteBranches(origin).includes('main') && remoteBranches(origin).includes('wip'));
  assert.match(result.stdout, /Deleted 2 local · 1 on origin/);
  const remoteConfirm = (await prompts(gum.log))[3];
  assert.ok(remoteConfirm.args.includes('--default=false'));
});

test('a remote branch that moved since the last fetch is refused, not deleted', async t => {
  const { root: dir, work, origin } = await fixture(t);
  const other = join(dir, 'other');
  git(dir, 'clone', '-q', origin, other);
  git(other, 'switch', '-q', 'merged');
  await commit(other, 'feat: pushed by someone else');
  git(other, 'push', '-q', 'origin', 'merged');
  const moved = git(origin, 'rev-parse', 'merged');
  const gum = await fakeGum(dir);
  const result = await cli(work, ['--no-fetch'], { ...gum.env, TIDY_GUM: 'pick:merged,yes,all,yes,none' });
  assert.equal(result.code, 1, result.stdout);
  assert.equal(git(origin, 'rev-parse', 'merged'), moved);
  assert.match(result.stdout, /✗ origin\/merged — .*stale info/);
});

test('declining, Esc and Ctrl-C delete nothing', async t => {
  const { root: dir, work, origin } = await fixture(t);
  const gum = await fakeGum(dir);
  const before = [branches(work), remoteBranches(origin)];
  for (const [script, code] of [
    ['all,no', 0],
    ['esc', 0],
    ['ctrl-c', 130],
    ['all,ctrl-c', 130],
  ] as const) {
    await run('rm', ['-f', join(dir, 'gum-step')]);
    const result = await cli(work, ['--no-fetch'], { ...gum.env, TIDY_GUM: script });
    assert.equal(result.code, code, `${script}: ${result.stdout}`);
    assert.deepEqual([branches(work), remoteBranches(origin)], before, script);
  }
});

test('fetch prunes branches deleted on the remote so they show up as gone', async t => {
  const { root: dir, work, origin } = await fixture(t);
  const other = join(dir, 'other');
  git(dir, 'clone', '-q', origin, other);
  git(other, 'push', '-q', 'origin', '--delete', 'merged');
  const result = await cli(work, ['--dry-run'], {}, false);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^gone\s+merged\s+origin\/merged/m);
});

test('nothing to tidy is reported cleanly', async t => {
  const { root: dir, work } = await fixture(t);
  for (const name of ['merged', 'gone']) git(work, 'branch', '-q', '-D', name);
  const gum = await fakeGum(dir);
  const result = await cli(work, ['--no-fetch', '--stale-after', 'never'], gum.env);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /Nothing to tidy/);
  assert.match(result.stdout, /Kept 4 branches: ahead \(has commits not in origin\/main\)/);
});

test('stale branches start unselected and are deleted only after a warning that names lost commits', async t => {
  const { root: dir, work, origin } = await fixture(t);
  const gum = await fakeGum(dir);
  const result = await cli(work, ['--no-fetch'], { ...gum.env, TIDY_GUM: 'none,pick:old-local,yes' });
  assert.equal(result.code, 0, result.stdout);
  assert.ok(!branches(work).includes('old-local'));
  assert.ok(branches(work).includes('old-pushed') && branches(work).includes('merged'));
  assert.ok(remoteBranches(origin).includes('old-pushed'));
  assert.match(result.stdout, /2 stale branches: no activity in 90 days/);
  assert.match(result.stdout, /Deleted 1 local · 0 on origin/);
  const [, stale, warning] = await prompts(gum.log);
  assert.ok(stale.args.includes('--selected='));
  assert.deepEqual(
    stale.options.map((option: string) => option.split('\t')[1]),
    ['old-local', 'old-pushed'],
  );
  assert.ok(warning.args.includes('--default=false'));
  assert.ok(
    warning.args.includes(
      'Delete 1 stale branch? 2 commits not in origin/main. 2 commits exist only in this clone and will be lost.',
    ),
  );
});

test('tidy.staleAfter sets the threshold, --stale-after overrides it, and bad values are rejected', async t => {
  const { work } = await fixture(t);
  git(work, 'config', 'tidy.staleAfter', '1 year');
  let result = await cli(work, ['--dry-run', '--no-fetch'], {}, false);
  assert.doesNotMatch(result.stdout, /^stale/m);
  assert.match(result.stdout, /0 stale \(no activity in 1 year\)/);
  result = await cli(work, ['--dry-run', '--no-fetch', '--stale-after', '30.days.ago'], {}, false);
  assert.match(result.stdout, /^stale\s+old-local/m);
  assert.match(result.stdout, /no activity in 30 days/);
  git(work, 'config', 'tidy.staleAfter', 'soon');
  result = await cli(work, ['--dry-run', '--no-fetch'], {}, false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /git config tidy.staleAfter must look like "90 days".*"soon"/);
});
