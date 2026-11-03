import { Failure } from '../../shared/src/errors.ts';

export const version = '1.0.0';

export const help = `git-wt ${version} — check out a branch as a sibling worktree

Usage:
  git wt <branch>
  git wt -h | --version

The worktree goes beside the others: root/<last part of the branch name>, where
root holds the bare repository (root/.bare) or the main checkout (root/repo).
Only the worktree path is printed on stdout, so this works:

  cd "$(git wt feature/ABC-123_name)"

  already checked out  prints the existing worktree path
  on origin            fetches it; a local branch with no commits of its own
                       is reset to origin's, otherwise it is left as it is
  local only           asks, then checks out the local branch
  new                  asks, fast-forwards the default branch's worktree when
                       it is clean, then branches from origin's default branch
                       with no upstream (the first push sets it)

Bare clones have no fetch refspec; git wt adds the standard one for origin.
`;

export function parseArgs(args: string[]): { command: 'help' | 'version' | 'wt'; branch: string } {
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) return { command: 'help', branch: '' };
  if (args.length === 1 && args[0] === '--version') return { command: 'version', branch: '' };
  if (args.length !== 1 || args[0].startsWith('-'))
    throw new Failure('configuration-invalid', 'Usage: git wt <branch>. Run git wt -h for details.');
  return { command: 'wt', branch: args[0] };
}
