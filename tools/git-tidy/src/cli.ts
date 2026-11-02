import { help, version, parseAge, parseArgs } from './args.ts';
import { Repo, chooseRemote, fetchRemote, findMain, readSetting, scan } from './branches.ts';
import type { Scan, StaleAfter } from './branches.ts';
import { deleteLocal, deleteRemote } from './delete.ts';
import type { Outcome } from './delete.ts';
import { branchLabels, choose, confirm, keptLine, plainLines, plural, renderOutcomes, renderPreview, staleLabels } from './ui.ts';
import { palette, requireGum, styleText as style } from '../../shared/src/gum.ts';
import { Failure, diagnostic } from '../../shared/src/errors.ts';

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort(signal));
const report = (line: string) => process.stderr.write(`git-tidy: ${diagnostic(line)}\n`);
const write = (text: string) => process.stderr.write(text + '\n');

type Outcomes = { local: Outcome[]; remote: Outcome[] };

// --stale-after wins over git config tidy.staleAfter, which wins over 90 days.
async function staleSetting(repo: Repo, flag?: string): Promise<StaleAfter | null> {
  const configured = flag === undefined ? await readSetting(repo, 'tidy.staleAfter') : undefined;
  const label = (flag ?? configured ?? '90 days').trim();
  const seconds = parseAge(label);
  if (seconds === undefined)
    throw new Failure('configuration-invalid', `${flag === undefined ? 'git config tidy.staleAfter' : '--stale-after'} must look like "90 days", "6 weeks", "1 year" or "never", not ${JSON.stringify(diagnostic(label))}.`);
  return seconds === null ? null : { label: label.replace(/[ .]+ago$/i, '').replace(/\./g, ' '), seconds };
}

// Merged and gone branches: all start selected. Merged upstreams may then go on the remote too.
async function tidyMerged(repo: Repo, found: Scan, signal: AbortSignal): Promise<Outcomes | 'cancel'> {
  const picked = await choose('Delete which merged branches? (Esc skips)', branchLabels(found.candidates), true, signal);
  if (picked === 'cancel') return 'cancel';
  const local = found.candidates.filter(c => picked.includes(c.name));
  if (!local.length) { report('No merged branches selected.'); return { local: [], remote: [] }; }
  const answer = await confirm(`Delete ${plural(local.length, 'local branch', 'es')}?`, 'Delete', false, signal);
  if (answer === 'cancel') return 'cancel';
  if (answer === 'no') { report('Merged branches were kept.'); return { local: [], remote: [] }; }
  const outcomes: Outcomes = { local: await deleteLocal(repo, local), remote: [] };
  write(await renderOutcomes('Local branches', outcomes.local, signal));

  // Offer remote deletion only for merged upstreams whose local branch is now gone.
  const deleted = new Set(outcomes.local.filter(outcome => outcome.ok).map(outcome => outcome.name));
  const remotable = local.filter(c => deleted.has(c.name) && c.kind === 'merged' && c.remoteSha);
  if (!remotable.length) return outcomes;
  const { remote } = found;
  const remotePicked = await choose(`Also delete these merged branches on ${remote}? None are selected; Esc skips.`,
    remotable.map(c => [`${remote}/${c.remoteBranch}`, c.name]), false, signal);
  if (remotePicked === 'cancel') return 'cancel';
  const chosen = remotable.filter(c => remotePicked.includes(c.name));
  if (!chosen.length) return outcomes;
  const remoteAnswer = await confirm(`Delete ${plural(chosen.length, 'branch', 'es')} on ${remote}? This affects everyone using ${remote}.`, 'Delete on remote', true, signal);
  if (remoteAnswer === 'cancel') return 'cancel';
  if (remoteAnswer === 'yes') {
    outcomes.remote = await deleteRemote(repo, remote, found.main, chosen);
    write(await renderOutcomes(`Branches on ${remote}`, outcomes.remote, signal));
  }
  return outcomes;
}

// Stale branches are not merged: nothing starts selected, and the confirmation says what is lost.
async function tidyStale(repo: Repo, found: Scan, signal: AbortSignal): Promise<Outcome[] | 'cancel'> {
  const picked = await choose('Delete which stale branches? They are not merged, so none are selected; Esc skips.',
    staleLabels(found.stale), false, signal);
  if (picked === 'cancel') return 'cancel';
  const chosen = found.stale.filter(s => picked.includes(s.name));
  if (!chosen.length) return [];
  const notInMain = chosen.reduce((sum, s) => sum + s.notInMain, 0), unpushed = chosen.reduce((sum, s) => sum + s.unpushed, 0);
  const loss = unpushed ? `${plural(unpushed, 'commit')} exist only in this clone and will be lost.` : 'Every commit is still on a remote.';
  const answer = await confirm(`Delete ${plural(chosen.length, 'stale branch', 'es')}? ${plural(notInMain, 'commit')} not in ${found.main.label}. ${loss}`,
    'Delete stale', true, signal);
  if (answer === 'cancel') return 'cancel';
  if (answer === 'no') { report('Stale branches were kept.'); return []; }
  const outcomes = await deleteLocal(repo, chosen);
  write(await renderOutcomes('Stale branches', outcomes, signal));
  return outcomes;
}

async function main(): Promise<number> {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === 'version') {
    process.stdout.write(command === 'help' ? help : `git-tidy ${version}\n`);
    return 0;
  }
  const signal = controller.signal;
  if (!options.dryRun && (!process.stdin.isTTY || !process.stderr.isTTY))
    throw new Failure('unavailable', 'git tidy needs an interactive terminal. Use --dry-run to list candidates without deleting.');
  const repo = new Repo(undefined, signal);
  await repo.validate();
  const staleAfter = await staleSetting(repo, options.staleAfter);
  if (!options.dryRun) await requireGum(signal);
  const remote = await chooseRemote(repo, options.remote);
  if (options.fetch) {
    if (process.stderr.isTTY) process.stderr.write(`\x1b[2mFetching ${remote}…\x1b[0m`);
    const fetched = await fetchRemote(repo, remote);
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[2K');
    if (!fetched) report(`Fetch from ${remote} failed; using the remote-tracking refs already here.`);
  }
  const found = await scan(repo, remote, await findMain(repo, remote), staleAfter);
  if (options.dryRun) {
    process.stdout.write(plainLines(found).join('\n') + '\n');
    return 0;
  }
  if (!found.candidates.length && !found.stale.length) {
    const stale = staleAfter ? `, and none has gone ${staleAfter.label} without activity` : '';
    write(await style(signal, `✓ Nothing to tidy: no local branches tracking ${remote} are merged into ${found.main.label}${stale}.`, `--foreground=${palette.ok}`));
    if (found.kept.length) write(await style(signal, keptLine(found.kept), `--foreground=${palette.dim}`));
    return 0;
  }

  write(await renderPreview(found, process.stderr.columns || 80, signal));
  const done: Outcomes = { local: [], remote: [] };
  const cancel = () => { report('Cancelled; nothing more was deleted.'); return 130; };
  if (found.candidates.length) {
    const merged = await tidyMerged(repo, found, signal);
    if (merged === 'cancel') return cancel();
    done.local.push(...merged.local);
    done.remote.push(...merged.remote);
  }
  if (found.stale.length) {
    const stale = await tidyStale(repo, found, signal);
    if (stale === 'cancel') return cancel();
    done.local.push(...stale);
  }

  const failed = [...done.local, ...done.remote].filter(outcome => !outcome.ok).length;
  const summary = [`${done.local.filter(outcome => outcome.ok).length} local`, `${done.remote.filter(outcome => outcome.ok).length} on ${remote}`, ...(failed ? [`${failed} failed`] : [])];
  write(await style(signal, `Deleted ${summary.join(' · ')}`, '--bold', `--foreground=${failed ? palette.warn : palette.ok}`));
  return failed ? 1 : 0;
}

try { process.exitCode = await main(); }
catch (error) {
  report(error instanceof Failure ? `${error.kind}: ${error.message}` : 'Unexpected failure; raw diagnostics suppressed.');
  process.exitCode = controller.signal.aborted ? (controller.signal.reason === 'SIGTERM' ? 143 : 130) : error instanceof Failure && error.kind === 'cancelled' ? 130 : 1;
}
