import { dirname, join } from 'node:path';
import type { RunOptions } from '../../shared/src/process.ts';
import { Repo } from '../../shared/src/git.ts';
import { Failure, diagnostic } from '../../shared/src/errors.ts';

export const remote = 'origin';

// Network children have no terminal, so a credential prompt must fail rather than wait unseen.
// Fetches and checkouts of large repositories can outlast the default 30 second deadline.
const network: RunOptions = { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 600_000 };

// Git's own complaint (its last stderr line) says why a worktree or fetch step failed.
async function step(repo: Repo, args: string[], action: string, options: RunOptions = {}): Promise<void> {
  const result = await repo.capture(args, options);
  if (result.code === 0) return;
  const reason = result.stderr.trim().split('\n').at(-1)?.replace(/^(fatal|error): /, '');
  throw new Failure('git-error', `${action} failed${reason ? `: ${diagnostic(reason)}` : '.'}`);
}

// Worktrees live beside the bare repository (root/.bare) or beside a normal checkout (root/repo/.git).
export async function worktreeRoot(repo: Repo): Promise<string> {
  const result = await repo.capture(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (result.code !== 0) throw new Failure('git-error', 'Run git wt inside a Git repository.');
  const common = result.stdout.trim();
  const bare = await new Repo(common, repo.signal).text(['rev-parse', '--is-bare-repository'], 'inspecting the repository');
  return bare === 'true' ? dirname(common) : dirname(dirname(common));
}

export const targetDir = (root: string, branch: string) => join(root, branch.split('/').at(-1)!);

// The branch name as Git spells it (check-ref-format expands @{-1}), or a failure if it is not valid.
export async function validBranch(repo: Repo, name: string): Promise<string> {
  const result = await repo.capture(['check-ref-format', '--branch', name]);
  if (result.code !== 0) throw new Failure('configuration-invalid', `Invalid branch name: ${diagnostic(name)}.`);
  return result.stdout.trim();
}

export type Worktree = { path: string; branch?: string };

// `git worktree list --porcelain -z`: NUL-terminated attribute lines, so any path survives.
export function parseWorktrees(porcelain: string): Worktree[] {
  const list: Worktree[] = [];
  for (const line of porcelain.split('\0')) {
    if (line.startsWith('worktree ')) list.push({ path: line.slice('worktree '.length) });
    else if (line.startsWith('branch refs/heads/') && list.length) list.at(-1)!.branch = line.slice('branch refs/heads/'.length);
  }
  return list;
}

export async function worktreeFor(repo: Repo, branch: string): Promise<string | undefined> {
  const porcelain = await repo.text(['worktree', 'list', '--porcelain', '-z'], 'listing worktrees');
  return parseWorktrees(porcelain).find(worktree => worktree.branch === branch)?.path;
}

// Bare clones have no fetch refspec, so remote-tracking branches (and upstreams) would not work.
// Returns whether the refspec had to be added.
export async function ensureFetchRefspec(repo: Repo): Promise<boolean> {
  const remotes = (await repo.text(['remote'], 'listing remotes')).split('\n');
  if (!remotes.includes(remote)) throw new Failure('configuration-invalid', `This repository has no remote called ${remote}.`);
  const result = await repo.capture(['config', '--get-all', `remote.${remote}.fetch`]);
  if (result.code === 0 && result.stdout.trim()) return false;
  if (result.code > 1) throw new Failure('configuration-invalid', `Cannot read git config remote.${remote}.fetch.`);
  await repo.text(['config', `remote.${remote}.fetch`, `+refs/heads/*:refs/remotes/${remote}/*`], 'adding a fetch refspec');
  return true;
}

// ls-remote --exit-code exits 2 when the branch is missing; anything else non-zero means no answer.
export async function remoteHas(repo: Repo, branch: string): Promise<boolean> {
  const result = await repo.capture(['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${branch}`], network);
  if (result.code === 0) return true;
  if (result.code === 2) return false;
  throw new Failure('unavailable', `Couldn't reach ${remote} (git ls-remote exited ${result.code}).`);
}

export const fetchBranch = (repo: Repo, branch: string) =>
  step(repo, ['fetch', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], `Fetching ${branch} from ${remote}`, network);

export const fetchAll = (repo: Repo) => step(repo, ['fetch', '--prune', remote], `Fetching ${remote}`, network);

export const hasLocal = async (repo: Repo, branch: string) =>
  (await repo.capture(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;

// `git clone --bare` copies every remote branch as a local one, so a "local" branch may just be a
// stale snapshot of a branch that has since been rebased. It is its own work only if git cherry
// finds commits whose changes are not on the remote branch.
export async function hasOwnCommits(repo: Repo, branch: string): Promise<boolean> {
  const cherry = await repo.text(['cherry', `refs/remotes/${remote}/${branch}`, `refs/heads/${branch}`], 'comparing with the remote branch');
  return cherry.split('\n').some(line => line.startsWith('+'));
}

export async function defaultBranch(repo: Repo): Promise<string> {
  const result = await repo.capture(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
  const name = result.code === 0 ? result.stdout.trim().replace(new RegExp(`^${remote}/`), '') : '';
  return name || 'main';
}

export const isDirty = async (repo: Repo, path: string) =>
  (await new Repo(path, repo.signal).text(['status', '--porcelain'], 'checking for local changes')) !== '';

export const fastForward = async (repo: Repo, path: string, base: string) =>
  (await new Repo(path, repo.signal).capture(['merge', '--ff-only', `${remote}/${base}`])).code === 0;

// The three ways to create the worktree: an existing local branch, a new branch tracking the
// remote one, or a new branch from the default branch whose upstream the first push sets.
export const addExisting = (repo: Repo, dir: string, branch: string) =>
  step(repo, ['worktree', 'add', dir, branch], 'git worktree add', network);
export const addTracking = (repo: Repo, dir: string, branch: string) =>
  step(repo, ['worktree', 'add', '--track', '-b', branch, dir, `${remote}/${branch}`], 'git worktree add', network);
export const addNew = (repo: Repo, dir: string, branch: string, base: string) =>
  step(repo, ['worktree', 'add', '--no-track', '-b', branch, dir, `${remote}/${base}`], 'git worktree add', network);

export const setUpstream = (repo: Repo, branch: string) =>
  step(repo, ['branch', `--set-upstream-to=${remote}/${branch}`, branch], 'Setting the upstream');

export const resetToRemote = (repo: Repo, dir: string, branch: string) =>
  step(new Repo(dir, repo.signal), ['reset', '-q', '--hard', `${remote}/${branch}`], `Resetting ${branch} to ${remote}/${branch}`);
