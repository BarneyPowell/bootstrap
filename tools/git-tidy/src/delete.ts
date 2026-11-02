import { Failure } from '../../shared/src/errors.ts';
import { protectedNames } from './branches.ts';
import type { Candidate, Main, Repo } from './branches.ts';

export type Outcome = { name: string; ok: boolean; detail?: string };

// Merged and gone tips are proven to be in main, so -D is safe; -d would wrongly refuse
// gone branches unless HEAD is main. Stale branches need -D by definition, and the
// user confirmed losing their commits. A branch that moved since the scan is left alone.
export async function deleteLocal(repo: Repo, candidates: { name: string; sha: string }[]): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const c of candidates) {
    const now = await repo.capture(['rev-parse', '--verify', '--quiet', `refs/heads/${c.name}`]);
    if (now.code !== 0 || now.stdout.trim() !== c.sha) { outcomes.push({ name: c.name, ok: false, detail: 'changed since the scan; kept' }); continue; }
    const result = await repo.capture(['branch', '-D', '--', c.name]);
    outcomes.push(result.code === 0 ? { name: c.name, ok: true } : { name: c.name, ok: false, detail: 'git branch -D failed' });
  }
  return outcomes;
}

// One push for all branches. Each deletion is leased on the sha we fetched, so a
// branch someone pushed to since then is rejected rather than deleted.
export async function deleteRemote(repo: Repo, remote: string, main: Main, candidates: Candidate[]): Promise<Outcome[]> {
  for (const c of candidates) {
    if (!c.remoteSha || c.remoteBranch === main.branch || protectedNames.has(c.remoteBranch))
      throw new Failure('invalid-output', `Refusing to delete ${remote}/${c.remoteBranch}; nothing was pushed.`);
  }
  // Terminal stdio stays attached so credential prompts work; porcelain results arrive on stdout.
  const result = await repo.capture(['push', '--porcelain',
    ...candidates.map(c => `--force-with-lease=refs/heads/${c.remoteBranch}:${c.remoteSha}`),
    remote, ...candidates.map(c => `:refs/heads/${c.remoteBranch}`)], { interactive: true, timeoutMs: 120_000 });
  const status = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    // Deletions print as ':refs/heads/<b>' or '(delete):refs/heads/<b>'.
    const match = /^(.)\t[^\t]*:refs\/heads\/(.+?)\t(.*)$/.exec(line);
    if (match) status.set(match[2], match[1] === '-' ? '' : match[3]);
  }
  return candidates.map(c => {
    const detail = status.get(c.remoteBranch);
    const name = `${remote}/${c.remoteBranch}`;
    return detail === '' ? { name, ok: true } : { name, ok: false, detail: detail ?? `push exited ${result.code}` };
  });
}
