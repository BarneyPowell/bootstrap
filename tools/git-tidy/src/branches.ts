import { run } from '../../shared/src/process.ts';
import type { RunOptions, Result } from '../../shared/src/process.ts';
import { Failure, cancelled, diagnostic } from '../../shared/src/errors.ts';

export type Kind = 'merged' | 'gone';
export type Candidate = {
  name: string; sha: string; kind: Kind; upstream: string; remoteBranch: string;
  // Remote-tracking sha at scan time; only set while the remote branch still exists.
  remoteSha?: string; age: string; subject: string;
};
// A branch with no recent activity that is not merged. Never deleted on the remote.
export type Stale = {
  name: string; sha: string; upstream: string; age: string; subject: string;
  // Commits missing from main, and the subset no remote-tracking ref holds either.
  notInMain: number; unpushed: number;
};
export type Kept = { name: string; reason: string };
export type Main = { ref: string; branch: string; label: string };
export type StaleAfter = { label: string; seconds: number };
export type Scan = { remote: string; main: Main; candidates: Candidate[]; stale: Stale[]; staleAfter: StaleAfter | null; kept: Kept[] };

// Long-lived branch names that are never offered, locally or on the remote.
export const protectedNames = new Set(['main', 'master', 'develop']);

export class Repo {
  cwd: string;
  signal?: AbortSignal;
  constructor(cwd = process.cwd(), signal?: AbortSignal) { this.cwd = cwd; this.signal = signal; }
  async capture(args: string[], options: RunOptions = {}): Promise<Result> {
    return await run('git', ['--no-pager', '-c', 'color.ui=false', ...args], { cwd: this.cwd, signal: this.signal, ...options });
  }
  async text(args: string[], action: string): Promise<string> {
    const result = await this.capture(args);
    if (result.code !== 0) throw new Failure('git-error', `Git ${args[0]} failed while ${action}.`);
    return result.stdout.replace(/\n$/, '');
  }
  async validate(): Promise<void> {
    if ((await this.capture(['rev-parse', '--is-inside-work-tree'])).stdout.trim() !== 'true')
      throw new Failure('git-error', 'Run git tidy inside a non-bare working-tree repository.');
  }
}

export async function readSetting(repo: Repo, key: string): Promise<string | undefined> {
  const result = await repo.capture(['config', '--get', key]);
  if (result.code === 1) return undefined;
  if (result.code !== 0) throw new Failure('configuration-invalid', `Cannot read git config ${key}; check its value and your Git config files.`);
  return result.stdout.trim();
}

export async function chooseRemote(repo: Repo, wanted?: string): Promise<string> {
  const remotes = (await repo.text(['remote'], 'listing remotes')).split('\n').filter(Boolean);
  if (wanted !== undefined) {
    if (!remotes.includes(wanted)) throw new Failure('configuration-invalid', `No remote named ${diagnostic(wanted)}. Run git remote to list them.`);
    return wanted;
  }
  if (remotes.includes('origin')) return 'origin';
  if (remotes.length === 1) return remotes[0];
  throw new Failure('configuration-invalid', remotes.length
    ? 'Several remotes and none is called origin; choose one with --remote <name>.'
    : 'This repository has no remotes, so there are no upstream branches to compare.');
}

// Terminal stdio stays attached so credential prompts work. A failed fetch is not
// fatal: the scan then uses the remote-tracking refs already here.
export async function fetchRemote(repo: Repo, remote: string): Promise<boolean> {
  try { return (await repo.capture(['fetch', '--prune', '--quiet', remote], { interactive: true, timeoutMs: 120_000 })).code === 0; }
  catch (error) {
    cancelled(repo.signal);
    if (error instanceof Failure) return false;
    throw error;
  }
}

// The remote's default branch, from <remote>/HEAD, else <remote>/main or <remote>/master.
export async function findMain(repo: Repo, remote: string): Promise<Main> {
  const prefix = `refs/remotes/${remote}/`;
  const head = await repo.capture(['symbolic-ref', '--quiet', `${prefix}HEAD`]);
  let ref = head.code === 0 ? head.stdout.trim() : '';
  if (!ref.startsWith(prefix)) {
    ref = '';
    for (const name of ['main', 'master']) {
      if ((await repo.capture(['rev-parse', '--verify', '--quiet', `${prefix}${name}^{commit}`])).code === 0) { ref = prefix + name; break; }
    }
  }
  if (!ref) throw new Failure('git-error', `Cannot find ${remote}'s main branch. Run git remote set-head ${remote} --auto, then retry.`);
  const branch = ref.slice(prefix.length);
  return { ref, branch, label: `${remote}/${branch}` };
}

const lines = (text: string) => text.split('\n').filter(Boolean);

// Last activity is the newer of the tip's commit date and the branch's newest reflog
// entry, so a branch just created from an old commit is not reported as stale.
async function lastActivity(repo: Repo, refname: string, committed: number): Promise<number> {
  const reflog = await repo.capture(['log', '-g', '-1', '--date=unix', '--format=%gd', refname, '--']);
  const updated = /@\{(\d+)\}$/.exec(reflog.stdout.trim());
  return Math.max(committed, updated ? Number(updated[1]) : 0);
}

const count = async (repo: Repo, args: string[]) => Number(await repo.text(['rev-list', '--count', ...args], 'counting commits'));

export async function scan(repo: Repo, remote: string, main: Main, staleAfter: StaleAfter | null, now = Date.now() / 1000): Promise<Scan> {
  const format = ['%(refname)', '%(objectname)', '%(upstream)', '%(upstream:remotename)', '%(upstream:remoteref)',
    '%(upstream:track)', '%(committerdate:relative)', '%(committerdate:unix)', '%(contents:subject)'].join('%00');
  const branches = lines(await repo.text(['for-each-ref', `--format=${format}`, 'refs/heads'], 'listing branches'))
    .map(line => line.split('\0'));
  const merged = new Set(lines(await repo.text(['for-each-ref', `--merged=${main.ref}`, '--format=%(refname)', 'refs/heads', `refs/remotes/${remote}`], 'checking merged branches')));
  const remoteShas = new Map(lines(await repo.text(['for-each-ref', '--format=%(refname)%00%(objectname)', `refs/remotes/${remote}`], 'listing remote branches'))
    .map(line => line.split('\0') as [string, string]));
  const head = await repo.capture(['symbolic-ref', '--quiet', 'HEAD']);
  const current = head.code === 0 ? head.stdout.trim() : '';
  const worktrees = new Set(lines(await repo.text(['worktree', 'list', '--porcelain'], 'listing worktrees'))
    .filter(line => line.startsWith('branch ')).map(line => line.slice(7)));
  const cutoff = staleAfter ? now - staleAfter.seconds : undefined;

  const candidates: Candidate[] = [], stale: Stale[] = [], kept: Kept[] = [];
  for (const [refname, sha, upstream, upstreamRemote, remoteRef, track, age, committed, subject] of branches) {
    const name = refname.slice('refs/heads/'.length);
    if (name === main.branch || protectedNames.has(name)) continue;
    // Merged or gone needs an upstream feature branch on this remote.
    const tracked = !!upstream && upstreamRemote === remote && remoteRef.startsWith('refs/heads/');
    const remoteBranch = tracked ? remoteRef.slice('refs/heads/'.length) : '';
    // Branches that track main or another long-lived branch are left alone entirely.
    if (tracked && (remoteBranch === main.branch || protectedNames.has(remoteBranch))) continue;
    const gone = track === '[gone]';
    const kind: Kind | undefined = tracked && (gone || merged.has(upstream)) ? (gone ? 'gone' : 'merged') : undefined;
    const busy = refname === current ? 'current branch' : worktrees.has(refname) ? 'checked out in another worktree' : undefined;
    const shortUpstream = upstream.replace(/^refs\/(remotes|heads)\//, '');
    if (kind && !busy && merged.has(refname)) {
      candidates.push({
        name, sha, kind, upstream: shortUpstream, remoteBranch,
        remoteSha: gone ? undefined : remoteShas.get(upstream), age, subject: diagnostic(subject),
      });
      continue;
    }
    const isStale = cutoff !== undefined && Number(committed) < cutoff && await lastActivity(repo, refname, Number(committed)) < cutoff;
    if (isStale && !busy) {
      stale.push({
        name, sha, age, subject: diagnostic(subject),
        upstream: !upstream ? 'local only' : gone ? `${shortUpstream} (gone)` : shortUpstream,
        notInMain: await count(repo, [sha, '--not', main.ref]), unpushed: await count(repo, [sha, '--not', '--remotes']),
      });
    } else if (busy && (kind || isStale)) kept.push({ name, reason: busy });
    else if (kind) kept.push({ name, reason: `has commits not in ${main.label}` });
  }
  return { remote, main, candidates, stale, staleAfter, kept };
}
