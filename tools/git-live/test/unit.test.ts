import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.ts';
import { pullRequestText } from '../src/live.ts';

test('arguments: none, --review, help and version; anything else is a usage error', () => {
  assert.deepEqual(parseArgs([]), { command: 'live', review: false });
  assert.deepEqual(parseArgs(['--review']), { command: 'live', review: true });
  assert.equal(parseArgs(['-h']).command, 'help');
  assert.equal(parseArgs(['--help']).command, 'help');
  assert.equal(parseArgs(['--version']).command, 'version');
  for (const args of [['--review', '--review'], ['main'], ['--auto'], ['-h', '--review']])
    assert.throws(() => parseArgs(args), /Usage: git live/);
});

test('pull request text lists commits in order and asks for a merge commit', () => {
  const commits = [
    { hash: 'abc1234', subject: 'feat(git): add an alias' },
    { hash: 'def5678', subject: 'chore: tweak settings' },
  ];
  const { title, body } = pullRequestText(commits, 'main');
  assert.equal(title, 'Ship live: 2 changes');
  assert.match(body, /- feat\(git\): add an alias \(abc1234\)\n- chore: tweak settings \(def5678\)/);
  assert.match(body, /Create a merge commit\*\*, not squash, so `live` can fast-forward to `main`/);
  assert.equal(pullRequestText(commits.slice(0, 1), 'main').title, 'Ship live: feat(git): add an alias');
});
