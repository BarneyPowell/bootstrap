# git-wt

`git wt <branch>` checks out a branch in its own worktree, beside your other
worktrees. If the branch is new, it creates it from origin's default branch.
The command prints only the worktree path on stdout, so you can change into it
in one step:

```sh
cd "$(git wt feature/ABC-123_name)"
```

## Where the worktree goes

The worktree is a sibling directory named after the last part of the branch
name. `feature/ABC-123_name` becomes `ABC-123_name`. Two layouts work:

| Layout | Repository | Worktree root |
| ------ | ---------- | ------------- |
| Bare | `root/.bare` (a `git clone --bare`) | `root/` |
| Normal | `root/repo/.git` | `root/` |

You can run `git wt` from any worktree of the repository.

## What it does with the branch

| The branch is…        | git wt…                                                              |
| --------------------- | -------------------------------------------------------------------- |
| already checked out   | prints that worktree's path. It changes nothing.                     |
| on origin             | fetches the branch and creates the worktree. It uses the local branch with its upstream set if one exists. Otherwise it creates a branch that tracks `origin/<branch>`. |
| only local            | asks, then checks out the local branch.                              |
| new                   | asks, then runs `git fetch --prune origin` and creates the branch from `origin/<default>` with no upstream. With `push.autoSetupRemote` on, your first `git push` sets it. |

For a new branch, `git wt` also fast-forwards the default branch's worktree
(such as `main`) to origin, if that worktree exists. It leaves the worktree
alone if it has local changes or cannot fast-forward, and tells you so.

The default branch comes from `origin/HEAD`. If `origin/HEAD` is not set, it is
`main`.

## Bare clones

`git clone --bare` leaves two things that `git wt` fixes:

- **No fetch refspec.** Without one, remote-tracking branches and upstreams do
  not work. `git wt` adds `+refs/heads/*:refs/remotes/origin/*` and warns once.
- **Every remote branch copied as a local one.** A local branch can be an old
  snapshot of a branch that has since been rebased on origin. If `git cherry`
  finds no commits of its own on the local branch, `git wt` resets it to
  `origin/<branch>`. If the local branch has commits that origin does not have,
  `git wt` leaves it as it is and warns.

## Usage

```sh
git wt feature/ABC-123_name      # prints the worktree path
cd "$(git wt feature/ABC-123_name)"
git wt -h
```

`git wt --help` is caught by Git, which looks for a man page. Use `-h`.

All messages go to stderr. The two questions (local-only branch, new branch)
use `gum confirm`. They need a terminal on stdin and stderr, but not on stdout,
which `$(…)` captures. Install gum with `make ensure-gum` in the bootstrap
clone. Branches that are already checked out or already on origin need no
questions and no gum.

Network steps run with `GIT_TERMINAL_PROMPT=0`, so a remote that needs
credentials fails at once instead of waiting for a prompt you cannot see.
Use an SSH key or a credential helper.

Exit codes: 0 when the worktree is ready (stdout holds its path). 1 on an error
or when you answer No. 130 on Ctrl+C.

## Requirements and tests

Node.js **22.18+**, the same as [git-ai](../git-ai/README.md). The process,
error, Git, gum and spinner helpers come from [`tools/shared`](../shared/README.md).
There are no npm dependencies.

```sh
make test-git-wt
```

The tests build temporary repositories in both layouts, each with a bare
origin, and use a fake gum. They never touch your real Git config or remotes.
