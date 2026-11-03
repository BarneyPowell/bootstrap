import { Failure } from '../../shared/src/errors.ts';

export const version = '1.0.0';

export const help = `git-tidy ${version} — delete local branches that are already merged

Usage:
  git tidy [--dry-run] [--no-fetch] [--remote <name>] [--stale-after <age>]
  git tidy -h | --version

A local branch is offered for deletion when it tracks a branch on <remote>
(default origin) and its tip is already in <remote>'s main branch, and either:
  merged  the upstream branch is merged into main too, or
  gone    the upstream branch was deleted on the remote.
Any other local branch with no activity for <age> (default 90 days) is listed
as stale. Stale branches may hold unmerged work, so they are offered in their
own picker with nothing selected, and never deleted on the remote.
The current branch, branches checked out in a worktree, and main/master/develop
are never touched. Squash or rebase merges are not detected.

gum shows the candidates; you choose which to delete and confirm. Merged
upstream branches can then also be deleted on the remote (opt-in, confirmed
separately, refused if the remote branch moved since the fetch).

  --dry-run   list candidates and change nothing (no terminal or gum needed)
  --no-fetch  skip git fetch --prune <remote> and use the refs already here
  --remote    remote to compare against (default origin, or the only remote)
  --stale-after
              age such as "90 days", "6 weeks", "1 year", or "never" to turn
              stale detection off; overrides git config tidy.staleAfter
`;

export type Options = { dryRun: boolean; fetch: boolean; remote?: string; staleAfter?: string };

export function parseArgs(args: string[]): { command: 'help' | 'version' | 'tidy'; options: Options } {
  const options: Options = { dryRun: false, fetch: true };
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) return { command: 'help', options };
  if (args.length === 1 && args[0] === '--version') return { command: 'version', options };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Failure('configuration-invalid', `Repeated option: ${flag}.`);
    seen.add(flag);
    if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--no-fetch') options.fetch = false;
    else if (flag === '--remote' || flag === '--stale-after') {
      const value = args[++i];
      if (value === undefined || value.startsWith('-'))
        throw new Failure('configuration-invalid', `Missing value for ${flag}.`);
      if (flag === '--remote') options.remote = value;
      else options.staleAfter = value;
    } else throw new Failure('configuration-invalid', `Unsupported option: ${flag}. Run git tidy -h.`);
  }
  return { command: 'tidy', options };
}

const units: Record<string, number> = { day: 86_400, week: 7 * 86_400, month: 30 * 86_400, year: 365 * 86_400 };

// "90 days", "6.weeks.ago", "1 year" → seconds; "never" → null. A month is 30 days.
// Anything else is rejected rather than guessed, unlike Git's approxidate.
export function parseAge(text: string): number | null | undefined {
  const value = text.trim().toLowerCase();
  if (value === 'never') return null;
  const match = /^(\d+)[ .]*(day|week|month|year)s?(?:[ .]+ago)?$/.exec(value);
  if (!match || Number(match[1]) < 1) return undefined;
  return Number(match[1]) * units[match[2]];
}
