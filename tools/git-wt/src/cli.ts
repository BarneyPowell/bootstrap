import { existsSync } from 'node:fs';
import { help, version, parseArgs } from './args.ts';
import {
  addExisting,
  addNew,
  addTracking,
  defaultBranch,
  ensureFetchRefspec,
  fastForward,
  fetchAll,
  fetchBranch,
  hasLocal,
  hasOwnCommits,
  isDirty,
  remote,
  remoteHas,
  resetToRemote,
  setUpstream,
  targetDir,
  validBranch,
  worktreeFor,
  worktreeRoot,
} from './worktree.ts';
import { Repo } from '../../shared/src/git.ts';
import { confirm, paint, palette, requireGum } from '../../shared/src/gum.ts';
import { Spinner, colour } from '../../shared/src/terminal.ts';
import { Failure, diagnostic } from '../../shared/src/errors.ts';

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort(signal));
// stdout carries only the worktree path, for cd "$(git wt …)"; everything else goes to stderr.
const report = (line: string, color?: string) => {
  const text = `git-wt: ${diagnostic(line)}`;
  process.stderr.write(`${color && colour(process.stderr) ? paint(color, text) : text}\n`);
};
const note = (line: string) => report(line, palette.dim);
const warn = (line: string) => report(line, palette.warn);

async function spin<T>(text: string, work: () => Promise<T>): Promise<T> {
  const spinner = new Spinner();
  spinner.update(text);
  try {
    return await work();
  } finally {
    spinner.stop();
  }
}

// gum confirm needs the terminal on stdin and stderr; stdout is usually captured by $(…).
async function ask(prompt: string, affirmative: string, signal: AbortSignal): Promise<'yes' | 'no' | 'cancel'> {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Failure('unavailable', `${prompt} git wt needs an interactive terminal to ask.`);
  await requireGum(signal);
  return await confirm(prompt, { affirmative, negative: 'Cancel', safeDefault: false }, signal);
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === 'help' || parsed.command === 'version') {
    process.stdout.write(parsed.command === 'help' ? help : `git-wt ${version}\n`);
    return 0;
  }
  const signal = controller.signal;
  const repo = new Repo(undefined, signal);
  const root = await worktreeRoot(repo);
  const branch = await validBranch(repo, parsed.branch);
  const done = (dir: string) => {
    process.stdout.write(`${dir}\n`);
    return 0;
  };
  const declined = (answer: 'no' | 'cancel') => {
    report('Cancelled; nothing was created.');
    return answer === 'cancel' ? 130 : 1;
  };

  const existing = await worktreeFor(repo, branch);
  if (existing) {
    note(`${branch} is already checked out at ${existing}`);
    return done(existing);
  }
  const dir = targetDir(root, branch);
  if (existsSync(dir)) throw new Failure('target-exists', `${dir} already exists.`);
  if (await ensureFetchRefspec(repo))
    warn(`${remote} had no fetch refspec; added +refs/heads/*:refs/remotes/${remote}/*`);

  if (await spin(`Checking ${remote} for ${branch}…`, () => remoteHas(repo, branch))) {
    await spin(`Fetching ${branch}…`, () => fetchBranch(repo, branch));
    if (await hasLocal(repo, branch)) {
      await addExisting(repo, dir, branch);
      await setUpstream(repo, branch);
      if (await hasOwnCommits(repo, branch))
        warn(`Local ${branch} has commits that aren't on ${remote}/${branch}; left as is.`);
      else await resetToRemote(repo, dir, branch);
    } else await addTracking(repo, dir, branch);
  } else if (await hasLocal(repo, branch)) {
    const answer = await ask(
      `${branch} exists locally but not on ${remote}. Create a worktree for it?`,
      'Create worktree',
      signal,
    );
    if (answer !== 'yes') return declined(answer);
    await addExisting(repo, dir, branch);
  } else {
    const answer = await ask(`${branch} isn't on ${remote}. Create it as a new branch?`, 'Create branch', signal);
    if (answer !== 'yes') return declined(answer);
    await spin(`Fetching ${remote}…`, () => fetchAll(repo));
    const base = await defaultBranch(repo);
    const baseWorktree = await worktreeFor(repo, base);
    if (baseWorktree && (await isDirty(repo, baseWorktree)))
      warn(`${baseWorktree} has local changes; not updating it.`);
    else if (
      baseWorktree &&
      !(await spin(`Fast-forwarding ${baseWorktree} to ${remote}/${base}…`, () =>
        fastForward(repo, baseWorktree, base),
      ))
    )
      warn(`${baseWorktree} couldn't fast-forward to ${remote}/${base}; left as is.`);
    await addNew(repo, dir, branch, base);
  }

  report(`Worktree ready: ${dir}`, palette.ok);
  return done(dir);
}

try {
  process.exitCode = await main();
} catch (error) {
  report(
    error instanceof Failure ? `${error.kind}: ${error.message}` : 'Unexpected failure; raw diagnostics suppressed.',
  );
  process.exitCode = controller.signal.aborted
    ? controller.signal.reason === 'SIGTERM'
      ? 143
      : 130
    : error instanceof Failure && error.kind === 'cancelled'
      ? 130
      : 1;
}
