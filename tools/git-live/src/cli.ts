import { help, version, parseArgs } from './args.ts';
import {
  commitsToShip,
  createPullRequest,
  enableAutoMerge,
  fetchRemote,
  ghReady,
  insideRepository,
  live,
  openPullRequest,
  pullRequestText,
  pushLive,
  relation,
  remote,
  resolve,
  updatePullRequest,
} from './live.ts';
import { Repo, defaultBranch } from '../../shared/src/git.ts';
import { paint, palette } from '../../shared/src/gum.ts';
import { Spinner, colour } from '../../shared/src/terminal.ts';
import { Failure, diagnostic } from '../../shared/src/errors.ts';

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort(signal));
// stdout carries only the pull request URL; everything else goes to stderr.
const report = (line: string, color?: string) => {
  const text = `git-live: ${diagnostic(line)}`;
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

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === 'help' || parsed.command === 'version') {
    process.stdout.write(parsed.command === 'help' ? help : `git-live ${version}\n`);
    return 0;
  }
  const repo = new Repo(undefined, controller.signal);
  await insideRepository(repo);
  await ghReady(repo);
  await spin(`Fetching ${remote}…`, () => fetchRemote(repo));
  const base = await defaultBranch(repo, remote);
  if (!(await resolve(repo, `refs/remotes/${remote}/${live}`)))
    throw new Failure('git-error', `${remote} has no ${live} branch.`);

  if (await resolve(repo, `refs/heads/${live}`)) {
    const state = await relation(repo, `refs/heads/${live}`, `refs/remotes/${remote}/${live}`);
    if (state === 'diverged')
      throw new Failure(
        'diverged',
        `Your ${live} and ${remote}/${live} have both changed. Run git pull on ${live}, then git live again.`,
      );
    if (state === 'ahead') {
      await spin(`Pushing ${live}…`, () => pushLive(repo));
      note(`Pushed your new ${live} commits to ${remote}.`);
    }
    if (state === 'behind')
      warn(`Your ${live} is behind ${remote}/${live}; run git pull on ${live}. Shipping ${remote}/${live}.`);
  }

  const commits = await commitsToShip(repo, base);
  if (!commits.length) {
    report(`${live} has nothing new for ${base}.`, palette.ok);
    return 0;
  }
  const { title, body } = pullRequestText(commits, base);
  const existing = await spin('Looking for an open pull request…', () => openPullRequest(repo, base));
  let url: string;
  if (existing) {
    await spin(`Updating pull request #${existing.number}…`, () => updatePullRequest(repo, existing.number, body));
    url = existing.url;
    report(`Updated the open pull request with ${commits.length} commit(s).`, palette.ok);
  } else {
    url = await spin('Opening a pull request…', () => createPullRequest(repo, base, title, body));
    report(`Opened a pull request for ${commits.length} commit(s).`, palette.ok);
  }

  if (parsed.review) note('Auto-merge is off (--review). Merge it with "Create a merge commit".');
  else {
    try {
      await spin('Turning on auto-merge…', () => enableAutoMerge(repo, url));
      note(`It will merge with a merge commit once the checks pass; then ${live} fast-forwards to ${base}.`);
    } catch (error) {
      if (!(error instanceof Failure) || error.kind !== 'gh-error') throw error;
      warn(`${error.message} Merge it yourself with "Create a merge commit".`);
      process.stdout.write(`${url}\n`);
      return 1;
    }
  }
  process.stdout.write(`${url}\n`);
  return 0;
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
