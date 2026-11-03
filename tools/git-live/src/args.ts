import { Failure } from '../../shared/src/errors.ts';

export const version = '1.0.0';

export const help = `git-live ${version} — ship the live branch to the default branch

Usage:
  git live [--review]
  git live -h | --version

Pushes your local live branch if it has new commits, then opens a pull request
from live into origin's default branch (main), listing live's commits. If one is
already open, it updates that pull request's description instead.

Unless you pass --review, it also turns on auto-merge with a merge commit, so the
pull request merges itself once the required checks pass. A merge commit (not a
squash) keeps live's commits on main, so live can then fast-forward to main.

Only the pull request URL is printed on stdout.

  --review   open or update the pull request without turning on auto-merge
`;

export type Parsed = { command: 'help' | 'version' | 'live'; review: boolean };

export function parseArgs(args: string[]): Parsed {
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) return { command: 'help', review: false };
  if (args.length === 1 && args[0] === '--version') return { command: 'version', review: false };
  if (args.length === 0) return { command: 'live', review: false };
  if (args.length === 1 && args[0] === '--review') return { command: 'live', review: true };
  throw new Failure('configuration-invalid', 'Usage: git live [--review]. Run git live -h for details.');
}
