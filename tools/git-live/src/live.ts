import { Repo } from '../../shared/src/git.ts';
import { run } from '../../shared/src/process.ts';
import type { RunOptions } from '../../shared/src/process.ts';
import { Failure, diagnostic } from '../../shared/src/errors.ts';

export const remote = 'origin';
export const live = 'live';

// Network children have no terminal, so a credential prompt must fail rather than wait unseen.
const network: RunOptions = { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 120_000 };

// The tool's own complaint (its last stderr line) says why a step failed.
function reason(stderr: string): string {
  const line = stderr.trim().split('\n').at(-1) ?? '';
  return line ? `: ${diagnostic(line)}` : '.';
}

async function step(repo: Repo, args: string[], action: string, options: RunOptions = {}): Promise<void> {
  const result = await repo.capture(args, options);
  if (result.code !== 0) throw new Failure('git-error', `${action} failed${reason(result.stderr)}`);
}

export async function insideRepository(repo: Repo): Promise<void> {
  if ((await repo.capture(['rev-parse', '--git-dir'])).code !== 0)
    throw new Failure('git-error', 'Run git live inside a clone of the repository.');
}

export const fetchRemote = (repo: Repo) => step(repo, ['fetch', '--prune', remote], `Fetching ${remote}`, network);

export async function resolve(repo: Repo, ref: string): Promise<string | undefined> {
  const result = await repo.capture(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

const isAncestor = async (repo: Repo, ancestor: string, descendant: string) =>
  (await repo.capture(['merge-base', '--is-ancestor', ancestor, descendant])).code === 0;

export type Relation = 'same' | 'ahead' | 'behind' | 'diverged';

// How the local branch stands against its remote copy.
export async function relation(repo: Repo, local: string, remoteRef: string): Promise<Relation> {
  const [a, b] = [await resolve(repo, local), await resolve(repo, remoteRef)];
  if (!a || !b) throw new Failure('git-error', `Cannot compare ${local} with ${remoteRef}.`);
  if (a === b) return 'same';
  if (await isAncestor(repo, b, a)) return 'ahead';
  if (await isAncestor(repo, a, b)) return 'behind';
  return 'diverged';
}

export const pushLive = (repo: Repo) =>
  step(repo, ['push', remote, `refs/heads/${live}:refs/heads/${live}`], `Pushing ${live}`, network);

export type Commit = { hash: string; subject: string };

// live's own commits that the base branch lacks. Merges are left out: a merge of main into
// live brings nothing new.
export async function commitsToShip(repo: Repo, base: string): Promise<Commit[]> {
  const out = await repo.text(
    ['log', '--no-merges', '--reverse', '--format=%h%x09%s', `${remote}/${base}..${remote}/${live}`],
    'listing the commits to ship',
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [hash, ...subject] = line.split('\t');
      return { hash, subject: subject.join('\t') };
    });
}

export function pullRequestText(commits: Commit[], base: string): { title: string; body: string } {
  const title = commits.length === 1 ? `Ship live: ${commits[0].subject}` : `Ship live: ${commits.length} changes`;
  const body = [
    `Changes from \`${live}\`:`,
    '',
    ...commits.map(commit => `- ${commit.subject} (${commit.hash})`),
    '',
    `Merge with **Create a merge commit**, not squash, so \`${live}\` can fast-forward to \`${base}\` afterwards.`,
    '',
    '<sub>Opened by `git live`.</sub>',
  ].join('\n');
  return { title, body };
}

// gh runs in the repository, so it picks the GitHub repository from its remotes.
async function gh(repo: Repo, args: string[], action: string): Promise<string> {
  const result = await run('gh', args, { cwd: repo.cwd, signal: repo.signal, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Failure('gh-error', `${action} failed${reason(result.stderr)}`);
  return result.stdout.trim();
}

export async function ghReady(repo: Repo): Promise<void> {
  try {
    await gh(repo, ['--version'], 'gh --version');
  } catch (error) {
    if (error instanceof Failure && error.kind === 'not-installed')
      throw new Failure('not-installed', 'git live needs the GitHub CLI (gh). Install it, then run gh auth login.');
    throw error;
  }
  const status = await run('gh', ['auth', 'status'], { cwd: repo.cwd, signal: repo.signal, timeoutMs: 30_000 });
  if (status.code !== 0) throw new Failure('auth-required', 'gh is not logged in. Run gh auth login, then retry.');
}

export async function openPullRequest(repo: Repo, base: string): Promise<{ number: number; url: string } | undefined> {
  const out = await gh(
    repo,
    ['pr', 'list', '--head', live, '--base', base, '--state', 'open', '--json', 'number,url', '--limit', '1'],
    'Looking for an open pull request',
  );
  const list: unknown = JSON.parse(out || '[]');
  if (!Array.isArray(list) || !list.length) return undefined;
  const { number, url } = list[0] as { number: unknown; url: unknown };
  if (typeof number !== 'number' || typeof url !== 'string')
    throw new Failure('invalid-output', 'gh returned an unexpected pull request listing.');
  return { number, url };
}

export async function createPullRequest(repo: Repo, base: string, title: string, body: string): Promise<string> {
  const out = await gh(
    repo,
    ['pr', 'create', '--base', base, '--head', live, '--title', title, '--body', body],
    'Creating the pull request',
  );
  const url = out.split('\n').at(-1) ?? '';
  if (!/\/pull\/\d+$/.test(url)) throw new Failure('invalid-output', 'gh did not print the new pull request URL.');
  return url;
}

export const updatePullRequest = (repo: Repo, number: number, body: string) =>
  gh(repo, ['pr', 'edit', String(number), '--body', body], 'Updating the pull request');

export const enableAutoMerge = (repo: Repo, url: string) =>
  gh(repo, ['pr', 'merge', url, '--auto', '--merge'], 'Turning on auto-merge');
