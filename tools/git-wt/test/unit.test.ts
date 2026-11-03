import '../../shared/test/git-env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.ts';
import { parseWorktrees, targetDir } from '../src/worktree.ts';

test('arguments: one branch, or -h / --version on their own', () => {
  assert.deepEqual(parseArgs(['feature/x']), { command: 'wt', branch: 'feature/x' });
  assert.equal(parseArgs(['-h']).command, 'help');
  assert.equal(parseArgs(['--help']).command, 'help');
  assert.equal(parseArgs(['--version']).command, 'version');
  for (const args of [[], ['a', 'b'], ['--force'], ['-b']])
    assert.throws(() => parseArgs(args), /Usage: git wt <branch>/);
});

test('worktrees: porcelain -z entries map paths to branches; bare and detached ones have none', () => {
  const porcelain = [
    'worktree /src/project/.bare',
    'bare',
    '',
    'worktree /src/project/main',
    'HEAD 1111',
    'branch refs/heads/main',
    '',
    'worktree /src/project/with space',
    'HEAD 2222',
    'branch refs/heads/feature/x',
    '',
    'worktree /src/project/detached',
    'HEAD 3333',
    'detached',
    '',
  ].join('\0');
  assert.deepEqual(parseWorktrees(porcelain), [
    { path: '/src/project/.bare' },
    { path: '/src/project/main', branch: 'main' },
    { path: '/src/project/with space', branch: 'feature/x' },
    { path: '/src/project/detached' },
  ]);
});

test('target directory: the last part of the branch name, under the worktree root', () => {
  assert.equal(targetDir('/src/project', 'feature/ABC-123_name'), '/src/project/ABC-123_name');
  assert.equal(targetDir('/src/project', 'plain'), '/src/project/plain');
});
