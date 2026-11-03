import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAge, parseArgs } from '../src/args.ts';
import { Repo, chooseRemote, findMain, scan } from '../src/branches.ts';
import { plainLines } from '../src/ui.ts';
import { fixture, git } from './helpers.ts';

test('arguments: defaults, flags, help and rejects anything else', () => {
  assert.deepEqual(parseArgs([]), { command: 'tidy', options: { dryRun: false, fetch: true } });
  assert.deepEqual(parseArgs(['--dry-run', '--no-fetch', '--remote', 'up', '--stale-after', '6 weeks']).options, {
    dryRun: true,
    fetch: false,
    remote: 'up',
    staleAfter: '6 weeks',
  });
  assert.equal(parseArgs(['-h']).command, 'help');
  assert.equal(parseArgs(['--version']).command, 'version');
  for (const args of [
    ['--remote'],
    ['--remote', '--dry-run'],
    ['--stale-after'],
    ['--dry-run', '--dry-run'],
    ['-D'],
    ['branch'],
  ])
    assert.throws(() => parseArgs(args));
});

test('ages: days, weeks, months and years, with or without "ago"; never; nothing guessed', () => {
  const day = 86_400;
  assert.equal(parseAge('90 days'), 90 * day);
  assert.equal(parseAge('1 day'), day);
  assert.equal(parseAge('6.weeks.ago'), 42 * day);
  assert.equal(parseAge(' 3 Months '), 90 * day);
  assert.equal(parseAge('1 year ago'), 365 * day);
  assert.equal(parseAge('never'), null);
  for (const text of ['90', '90d', '0 days', 'soon', '2 fortnights', '-1 days', ''])
    assert.equal(parseAge(text), undefined, text);
});

test('scan offers merged and gone branches and explains every held-back one', async t => {
  const { work } = await fixture(t);
  const repo = new Repo(work);
  const main = await findMain(repo, 'origin');
  assert.deepEqual(main, { ref: 'refs/remotes/origin/main', branch: 'main', label: 'origin/main' });
  const result = await scan(repo, 'origin', main, { label: '90 days', seconds: 90 * 86_400 });
  assert.deepEqual(
    result.candidates.map(c => [c.name, c.kind, c.upstream, c.remoteBranch, !!c.remoteSha]),
    [
      ['gone', 'gone', 'origin/gone', 'gone', false],
      ['merged', 'merged', 'origin/merged', 'merged', true],
    ],
  );
  assert.equal(result.candidates[1].sha, git(work, 'rev-parse', 'merged'));
  assert.equal(result.candidates[1].remoteSha, git(work, 'rev-parse', 'origin/merged'));
  assert.equal(result.candidates[1].subject, 'feat: merged work');
  assert.deepEqual(result.kept, [
    { name: 'ahead', reason: 'has commits not in origin/main' },
    { name: 'current', reason: 'current branch' },
    { name: 'gone-unmerged', reason: 'has commits not in origin/main' },
    { name: 'in-worktree', reason: 'checked out in another worktree' },
  ]);
  assert.deepEqual(
    result.stale.map(s => [s.name, s.upstream, s.notInMain, s.unpushed, s.subject]),
    [
      ['old-local', 'local only', 2, 2, 'feat: more abandoned work'],
      ['old-pushed', 'origin/old-pushed', 1, 0, 'feat: pushed but never merged'],
    ],
  );
  const lines = plainLines(result);
  assert.match(lines[0], /^gone\s+gone\s+origin\/gone · .* · feat: gone work$/);
  assert.match(
    lines[2],
    /^stale\s+old-local\s+local only · .* · 2 commits not in main, 2 unpushed · feat: more abandoned work$/,
  );
  assert.equal(lines.at(-1), 'Can delete: 2 merged, 2 stale (no activity in 90 days) (vs origin/main).');
});

test('stale detection: threshold, off switch, and busy branches are kept', async t => {
  const { work, worktree } = await fixture(t);
  const repo = new Repo(work);
  const main = await findMain(repo, 'origin');
  assert.deepEqual((await scan(repo, 'origin', main, null)).stale, []);
  assert.deepEqual((await scan(repo, 'origin', main, { label: '1 year', seconds: 365 * 86_400 })).stale, []);
  git(worktree, 'switch', '-q', 'old-pushed');
  const result = await scan(repo, 'origin', main, { label: '90 days', seconds: 90 * 86_400 });
  assert.deepEqual(
    result.stale.map(s => s.name),
    ['old-local'],
  );
  assert.ok(
    result.kept.some(entry => entry.name === 'old-pushed' && entry.reason === 'checked out in another worktree'),
  );
});

test('main branch: origin/HEAD wins, then main, then master; otherwise a set-head hint', async t => {
  const { work } = await fixture(t);
  const repo = new Repo(work);
  git(work, 'switch', '-q', '-c', 'trunk', 'main');
  git(work, 'push', '-q', 'origin', 'trunk');
  git(work, 'remote', 'set-head', 'origin', 'trunk');
  assert.equal((await findMain(repo, 'origin')).ref, 'refs/remotes/origin/trunk');
  git(work, 'remote', 'set-head', 'origin', '--delete');
  assert.equal((await findMain(repo, 'origin')).ref, 'refs/remotes/origin/main');
  git(work, 'push', '-q', 'origin', 'main:master');
  git(work, 'update-ref', '-d', 'refs/remotes/origin/main');
  assert.equal((await findMain(repo, 'origin')).ref, 'refs/remotes/origin/master');
  git(work, 'update-ref', '-d', 'refs/remotes/origin/master');
  await assert.rejects(findMain(repo, 'origin'), /git remote set-head origin --auto/);
});

test('scan ignores branches tracking another remote and never offers the remote default branch', async t => {
  const { work, origin } = await fixture(t);
  git(work, 'remote', 'add', 'other', origin);
  git(work, 'fetch', '-q', 'other');
  git(work, 'branch', '-q', '--track', 'via-other', 'other/merged');
  git(work, 'switch', '-q', '-c', 'trunk', 'main');
  git(work, 'push', '-q', '-u', 'origin', 'trunk');
  const repo = new Repo(work);
  // trunk as the default: the trunk branch itself is never a candidate.
  git(work, 'remote', 'set-head', 'origin', 'trunk');
  const result = await scan(repo, 'origin', await findMain(repo, 'origin'), null);
  assert.ok(!result.candidates.some(c => ['via-other', 'trunk', 'main', 'tracks-main'].includes(c.name)));
  assert.ok(!result.kept.some(entry => entry.name === 'trunk'));
});

test('remote choice: origin, the only remote, or an explicit name', async t => {
  const { work } = await fixture(t);
  const repo = new Repo(work);
  assert.equal(await chooseRemote(repo), 'origin');
  await assert.rejects(chooseRemote(repo, 'nope'), /No remote named nope/);
  git(work, 'remote', 'rename', 'origin', 'upstream');
  assert.equal(await chooseRemote(repo), 'upstream');
  git(work, 'remote', 'add', 'fork', 'file:///nonexistent');
  await assert.rejects(chooseRemote(repo), /--remote <name>/);
  assert.equal(await chooseRemote(repo, 'fork'), 'fork');
});
