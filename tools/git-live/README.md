# git-live

`git live` ships the `live` branch to `main`. It pushes your local `live` if it
has new commits, opens a pull request from `live` into `main` listing them, and
turns on auto-merge with a merge commit. Once the required checks pass, the pull
request merges itself, and the [Sync live](../../.github/workflows/sync-live.yml)
workflow fast-forwards `live` to `main`.

```sh
git live            # ship, and auto-merge when the checks pass
git live --review   # ship, but leave the pull request for you to merge
```

Only the pull request URL is printed on stdout.

## The cycle

1. Commit small changes on `live`, and push them (or let `git live` push them).
2. Run `git live` whenever you want them on `main`.
3. The pull request merges with a merge commit. `main` then contains every
   commit on `live`.
4. The Sync live workflow fast-forwards `live` to `main`. No merge commit is
   made and there is nothing to resolve.
5. Run `git pull` on `live` before adding more, to pick up the fast-forward.

Merge `live` pull requests with **Create a merge commit**, never squash. A
squash gives `main` a copy of `live`'s commits under new hashes, so `live` can no
longer fast-forward and would need a real merge. `git live` sets this for
auto-merge and says so in the pull request description.

## What it does with your branches

| Your local `live` is… | git live…                                                     |
| --------------------- | ------------------------------------------------------------- |
| missing               | ships `origin/live` as it is.                                  |
| the same as origin's  | ships it.                                                      |
| ahead of origin's     | pushes it, then ships it.                                      |
| behind origin's       | leaves it alone, says to run `git pull`, and ships `origin/live`. |
| diverged from origin's | stops before pushing or opening anything; run `git pull` first. |

If `live` has no commits that `main` lacks, it says so and does nothing. Merges
of `main` into `live` don't count as new work. If a `live` pull request is
already open, it updates that pull request's description instead of opening
another.

If `live` gains commits after a pull request merges but before the workflow
runs, `live` can't fast-forward. The workflow leaves it alone and those commits
go to `main` with the next `git live`.

## Requirements and tests

Node.js **24+**, Git, and the [GitHub CLI](https://cli.github.com/) (`gh`),
logged in with `gh auth login`. Auto-merge must be allowed in the repository
settings; it is here. `git live` works with the `origin` remote, the `live`
branch, and origin's default branch.

```sh
make test-git-live
```

The tests use temporary repositories and a fake `gh`; they never contact GitHub.
