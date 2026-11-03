import test from 'node:test';
import assert from 'node:assert/strict';
import { cli, commit, fixture, ghCalls, git, pushToLive } from './helpers.ts';

const call = (calls: string[][], command: string) => calls.find(args => args.slice(0, 2).join(' ') === command);
const flag = (args: string[] | undefined, name: string) => args?.[args.indexOf(name) + 1];

test('opens a pull request from live into main listing its commits, with auto-merge as a merge commit', async t => {
  const f = await fixture(t);
  await pushToLive(f, 'feat(git): add an alias', 'chore: tweak settings');
  const result = await cli(f, []);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'https://github.com/owner/repo/pull/7\n');
  const calls = await ghCalls(f);
  const create = call(calls, 'pr create');
  assert.equal(flag(create, '--base'), 'main');
  assert.equal(flag(create, '--head'), 'live');
  assert.equal(flag(create, '--title'), 'Ship live: 2 changes');
  const body = flag(create, '--body') ?? '';
  assert.ok(body.indexOf('feat(git): add an alias') < body.indexOf('chore: tweak settings'), body);
  assert.match(body, /Create a merge commit/);
  assert.deepEqual(call(calls, 'pr merge'), [
    'pr',
    'merge',
    'https://github.com/owner/repo/pull/7',
    '--auto',
    '--merge',
  ]);
});

test('one commit becomes the pull request title', async t => {
  const f = await fixture(t);
  await pushToLive(f, 'feat(git): add an alias');
  const result = await cli(f, []);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(flag(call(await ghCalls(f), 'pr create'), '--title'), 'Ship live: feat(git): add an alias');
});

test('--review opens the pull request without auto-merge', async t => {
  const f = await fixture(t);
  await pushToLive(f, 'feat: something');
  const result = await cli(f, ['--review']);
  assert.equal(result.code, 0, result.stderr);
  const calls = await ghCalls(f);
  assert.ok(call(calls, 'pr create'));
  assert.equal(call(calls, 'pr merge'), undefined);
  assert.match(result.stderr, /Auto-merge is off/);
});

test('an open pull request is updated rather than duplicated', async t => {
  const f = await fixture(t);
  await pushToLive(f, 'feat: first', 'feat: second');
  const open = JSON.stringify([{ number: 12, url: 'https://github.com/owner/repo/pull/12' }]);
  const result = await cli(f, [], { GH_OPEN: open });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'https://github.com/owner/repo/pull/12\n');
  const calls = await ghCalls(f);
  assert.equal(call(calls, 'pr create'), undefined);
  const edit = call(calls, 'pr edit');
  assert.equal(edit?.[2], '12');
  assert.match(flag(edit, '--body') ?? '', /feat: first[\s\S]*feat: second/);
  assert.equal(call(calls, 'pr merge')?.[2], 'https://github.com/owner/repo/pull/12');
});

test('nothing to ship when live has no commits that main lacks; merges of main into live do not count', async t => {
  const f = await fixture(t);
  const plain = await cli(f, []);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(plain.stdout, '');
  assert.match(plain.stderr, /live has nothing new for main/);
  // A merge of main into live, after main moved on, is not work to ship.
  await commit(f.seed, 'feat: on main');
  git(f.seed, 'push', '-q', 'origin', 'main');
  git(f.seed, 'switch', '-q', '-C', 'live', 'origin/live');
  git(f.seed, 'merge', '-q', '--no-ff', '--no-edit', 'main');
  git(f.seed, 'push', '-q', 'origin', 'live');
  const merged = await cli(f, []);
  assert.equal(merged.code, 0, merged.stderr);
  assert.match(merged.stderr, /nothing new/);
  assert.deepEqual(
    (await ghCalls(f)).filter(args => args[0] === 'pr' && args[1] !== 'list'),
    [],
  );
});

test('new local live commits are pushed first and shipped', async t => {
  const f = await fixture(t);
  git(f.cwd, 'switch', '-q', 'live');
  await commit(f.cwd, 'feat: made locally');
  const result = await cli(f, []);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Pushed your new live commits/);
  assert.equal(git(f.origin, 'rev-parse', 'live'), git(f.cwd, 'rev-parse', 'live'));
  assert.match(flag(call(await ghCalls(f), 'pr create'), '--body') ?? '', /feat: made locally/);
});

test('a local live that is behind is left alone, with a hint, and origin/live is shipped', async t => {
  const f = await fixture(t);
  git(f.cwd, 'switch', '-q', 'live');
  await pushToLive(f, 'feat: from elsewhere');
  const before = git(f.cwd, 'rev-parse', 'live');
  const result = await cli(f, []);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /behind origin\/live; run git pull/);
  assert.equal(git(f.cwd, 'rev-parse', 'live'), before);
  assert.match(flag(call(await ghCalls(f), 'pr create'), '--body') ?? '', /feat: from elsewhere/);
});

test('a local live that has diverged stops before pushing or opening anything', async t => {
  const f = await fixture(t);
  git(f.cwd, 'switch', '-q', 'live');
  await commit(f.cwd, 'feat: local');
  await pushToLive(f, 'feat: remote');
  const remoteLive = git(f.origin, 'rev-parse', 'live');
  const result = await cli(f, []);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Run git pull on live, then git live again/);
  assert.equal(git(f.origin, 'rev-parse', 'live'), remoteLive);
  assert.equal(call(await ghCalls(f), 'pr create'), undefined);
});

test('gh must be logged in', async t => {
  const f = await fixture(t);
  await pushToLive(f, 'feat: something');
  const result = await cli(f, [], { GH_AUTH: 'fail' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /gh auth login/);
  assert.equal(call(await ghCalls(f), 'pr create'), undefined);
});

test('a failed auto-merge still prints the pull request and says how to merge it', async t => {
  const f = await fixture(t);
  await pushToLive(f, 'feat: something');
  const result = await cli(f, [], { GH_MERGE: 'fail' });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, 'https://github.com/owner/repo/pull/7\n');
  assert.match(result.stderr, /auto-merge is not allowed[\s\S]*Create a merge commit/);
});

test('a repository without a live branch on origin is an error', async t => {
  const f = await fixture(t);
  git(f.seed, 'push', '-q', 'origin', '--delete', 'live');
  const result = await cli(f, []);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /origin has no live branch/);
});
