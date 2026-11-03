import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cli, commit, fixture, git } from './helpers.ts';

const upstream = (cwd: string, branch: string) => {
  try {
    return git(cwd, 'rev-parse', '--abbrev-ref', `${branch}@{upstream}`);
  } catch {
    return undefined;
  }
};
const prompts = async (log: string) =>
  existsSync(log)
    ? (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
    : [];

test('a branch on origin becomes a tracking worktree beside the checkout; stdout is only its path', async t => {
  const f = await fixture(t, 'normal');
  const result = await cli(f, ['feature/on-origin']);
  const dir = join(f.project, 'on-origin');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${dir}\n`);
  assert.match(result.stderr, /Worktree ready/);
  assert.equal(git(dir, 'branch', '--show-current'), 'feature/on-origin');
  assert.equal(upstream(f.cwd, 'feature/on-origin'), 'origin/feature/on-origin');
  assert.deepEqual(await prompts(f.gum.log), []);
});

test('a branch already checked out prints its worktree, with no terminal or gum', async t => {
  const f = await fixture(t, 'normal');
  const result = await cli(f, ['main']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${f.cwd}\n`);
  assert.match(result.stderr, /main is already checked out/);
});

test('an existing target directory stops before anything changes', async t => {
  const f = await fixture(t, 'normal');
  await mkdir(join(f.project, 'on-origin'));
  const result = await cli(f, ['feature/on-origin']);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /target-exists: .*on-origin already exists/);
  assert.equal(git(f.cwd, 'branch', '--list', 'feature/on-origin'), '');
});

test('bare clone: adds the missing refspec and resets a stale local snapshot to origin', async t => {
  const f = await fixture(t, 'bare');
  const bare = join(f.project, '.bare');
  assert.throws(() => git(bare, 'config', '--get', 'remote.origin.fetch'));
  // Rebase the branch on origin: same change, new commit, so the clone's copy is a stale snapshot.
  await commit(f.seed, 'chore: move main on');
  git(f.seed, 'push', '-q', 'origin', 'main');
  git(f.seed, 'switch', '-q', 'feature/on-origin');
  git(f.seed, 'rebase', '-q', 'main');
  git(f.seed, 'push', '-q', '--force', 'origin', 'feature/on-origin');
  const result = await cli(f, ['feature/on-origin']);
  const dir = join(f.project, 'on-origin');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${dir}\n`);
  assert.match(result.stderr, /no fetch refspec; added/);
  assert.equal(git(bare, 'config', '--get', 'remote.origin.fetch'), '+refs/heads/*:refs/remotes/origin/*');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), git(f.seed, 'rev-parse', 'feature/on-origin'));
  assert.equal(upstream(dir, 'feature/on-origin'), 'origin/feature/on-origin');
});

test('bare clone: a local branch with its own commits is left as it is', async t => {
  const f = await fixture(t, 'bare');
  const bare = join(f.project, '.bare'),
    scratch = join(f.project, 'scratch');
  git(bare, 'worktree', 'add', '-q', scratch, 'feature/ahead');
  await commit(scratch, 'feat: local only work');
  const tip = git(scratch, 'rev-parse', 'HEAD');
  git(bare, 'worktree', 'remove', scratch);
  const result = await cli(f, ['feature/ahead']);
  const dir = join(f.project, 'ahead');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /has commits that aren't on origin\/feature\/ahead; left as is/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), tip);
  assert.equal(upstream(dir, 'feature/ahead'), 'origin/feature/ahead');
});

test('a local-only branch is checked out after confirming; No creates nothing', async t => {
  const f = await fixture(t, 'normal');
  git(f.cwd, 'branch', 'local-only', 'main');
  const dir = join(f.project, 'local-only');

  const declined = await cli(f, ['local-only'], { gum: 'no', interactive: true });
  assert.equal(declined.code, 1, declined.stdout);
  assert.match(declined.stdout, /Cancelled; nothing was created/);
  assert.equal(existsSync(dir), false);

  const accepted = await cli(f, ['local-only'], { gum: 'yes', interactive: true });
  assert.equal(accepted.code, 0, accepted.stdout);
  assert.equal(git(dir, 'branch', '--show-current'), 'local-only');
  const asked = await prompts(f.gum.log);
  assert.equal(asked.length, 2);
  assert.match(asked[0].args.at(-1), /local-only exists locally but not on origin/);
});

test('a new branch starts from origin/main with no upstream, after fast-forwarding a clean main', async t => {
  const f = await fixture(t, 'normal');
  await commit(f.seed, 'feat: newer main');
  git(f.seed, 'push', '-q', 'origin', 'main');
  const result = await cli(f, ['feature/brand-new'], { gum: 'yes', interactive: true });
  const dir = join(f.project, 'brand-new');
  assert.equal(result.code, 0, result.stdout);
  const tip = git(f.seed, 'rev-parse', 'main');
  assert.equal(git(f.cwd, 'rev-parse', 'main'), tip);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), tip);
  assert.equal(upstream(dir, 'feature/brand-new'), undefined);
  assert.match((await prompts(f.gum.log))[0].args.at(-1), /feature\/brand-new isn't on origin/);
});

test('a new branch leaves a main worktree with local changes alone', async t => {
  const f = await fixture(t, 'normal');
  const before = git(f.cwd, 'rev-parse', 'main');
  await commit(f.seed, 'feat: newer main');
  git(f.seed, 'push', '-q', 'origin', 'main');
  await writeFile(join(f.cwd, 'notes.txt'), 'uncommitted\n');
  const result = await cli(f, ['feature/brand-new'], { gum: 'yes', interactive: true });
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /has local changes; not updating it/);
  assert.equal(git(f.cwd, 'rev-parse', 'main'), before);
  assert.equal(git(join(f.project, 'brand-new'), 'rev-parse', 'HEAD'), git(f.seed, 'rev-parse', 'main'));
});

test('Ctrl+C at the prompt exits 130 and creates nothing', async t => {
  const f = await fixture(t, 'normal');
  const result = await cli(f, ['feature/brand-new'], { gum: 'ctrl-c', interactive: true });
  assert.equal(result.code, 130, result.stdout);
  assert.equal(existsSync(join(f.project, 'brand-new')), false);
  assert.equal(git(f.cwd, 'branch', '--list', 'feature/brand-new'), '');
});

test('a prompt without a terminal is refused', async t => {
  const f = await fixture(t, 'normal');
  const result = await cli(f, ['feature/brand-new'], { gum: 'yes' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /needs an interactive terminal/);
  assert.deepEqual(await prompts(f.gum.log), []);
});

test('usage errors, invalid names and an unreachable origin fail clearly', async t => {
  const f = await fixture(t, 'normal');
  const usage = await cli(f, []);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /Usage: git wt <branch>/);
  const invalid = await cli(f, ['bad..name']);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /Invalid branch name: bad\.\.name/);
  git(f.cwd, 'remote', 'set-url', 'origin', join(f.project, 'missing.git'));
  const unreachable = await cli(f, ['feature/on-origin']);
  assert.equal(unreachable.code, 1);
  assert.match(unreachable.stderr, /unavailable: Couldn't reach origin/);
  git(f.cwd, 'remote', 'remove', 'origin');
  const noRemote = await cli(f, ['feature/on-origin']);
  assert.equal(noRemote.code, 1);
  assert.match(noRemote.stderr, /no remote called origin/);
});
