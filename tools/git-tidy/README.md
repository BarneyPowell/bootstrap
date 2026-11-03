# git-tidy

`git tidy` removes local branches that have no work left on them because their
upstream branch is already merged into the remote's main branch. It also lists
**stale** branches, which have had no activity for a set time (90 days by
default), and offers to delete them too.

1. It runs `git fetch --prune <remote>`, so branches deleted on the remote show
   as gone.
2. It finds the candidates and shows them in **gum** tables, one for merged
   branches and one for stale branches.
3. You choose the merged branches to delete. All of them start selected. `x`
   or Tab toggles a branch, Ctrl+A selects all, Enter continues, and Esc skips
   the step. Ctrl+C stops the whole run.
4. `gum confirm` asks before it deletes anything.
5. If any deleted branches still exist on the remote and are merged, a second
   picker offers to delete them there as well. Nothing is selected in this
   picker, and a separate confirmation follows (its default is **Keep**),
   because a remote deletion affects everyone who uses the remote.
6. Then you choose the stale branches to delete. Nothing is selected, and the
   confirmation (default **Keep**) says how many commits are not in main and how
   many exist only in this clone. Stale branches are never deleted on the
   remote.

## What counts as tidy-able

A local branch is a candidate when it tracks a branch on `<remote>`, its tip is
already in `<remote>`'s main branch, and one of these is true:

| Status   | Meaning                                                              |
| -------- | -------------------------------------------------------------------- |
| `merged` | The upstream branch is also merged into main. You can delete it on the remote too. |
| `gone`   | The upstream branch was deleted on the remote, for example after a PR merge. |

The main branch is `<remote>/HEAD`. If that is not set, the tool tries
`<remote>/main` and then `<remote>/master`. If none of these exist, run
`git remote set-head origin --auto`.

### Stale branches

Any other local branch is **stale** when it has had no activity for the
threshold. This includes branches with no upstream, branches whose upstream is
gone, and branches whose upstream is on another remote. Activity is the newer of:

- the tip commit's committer date, and
- the newest entry in the branch's reflog.

Because of the reflog check, a branch you created today from an old commit is
not stale. The stale table shows each branch's upstream (or `local only`) and
two commit counts. **Unmerged** commits are not in main. **Unpushed** commits
are on no remote-tracking branch, so deleting the branch loses them.

Set the threshold with an age like `90 days`, `6 weeks`, `3 months` (a month is
30 days) or `1 year`. A trailing `ago` is allowed. Use `never` to turn stale
detection off. Short forms such as `90d` are rejected, not guessed.

```sh
git config --global tidy.staleAfter "6 months"   # every repository
git config tidy.staleAfter never                 # just this one
git tidy --stale-after "2 weeks"                 # just this run
```

`--stale-after` overrides `tidy.staleAfter`, which overrides the default of 90
days.

### Never deleted

The preview lists these branches as **kept**, with the reason:

- the current branch, and branches checked out in another worktree
- branches with commits that are not in main, for example unpushed work on a
  merged upstream, unless they are also stale

These branches are ignored without a message:

- branches that are not merged and not stale
- branches that track main, and branches named `main`, `master` or `develop`

### Squash and rebase merges

A squash or rebase merge gives main new commits, so the branch's own commits
never become part of main's history. Version 1 does not detect these merges. If
GitHub deleted the head branch after the merge, the branch shows as `gone`.
But its tip is not in main, so it is kept as "has commits not in origin/main".
Once it is older than the stale threshold, it is offered as stale. You can also
delete it yourself with `git branch -D`.

## Safety

- The scan uses `git merge-base` reachability to prove that each tip is in main.
  Because of this, the tool uses `git branch -D`. Plain `-d` refuses `gone`
  branches unless you are on main. Before each deletion, the tool checks that
  the branch still points at the commit it scanned. If it does not, the branch
  is kept. Stale branches are not merged, so `-D` is the only way to delete
  them. This is why they start unselected and need their own confirmation.
- Remote deletions use one `git push`. Each branch has
  `--force-with-lease=<branch>:<fetched sha>`, so the remote refuses to delete
  a branch that someone pushed to after your fetch. Results are shown for each
  branch.
- Exit codes: 0 when the tool finishes, declines or finds nothing to tidy. 1
  when a deletion fails. 130 on Ctrl+C.

## Usage

```sh
git tidy               # fetch, preview, choose, confirm
git tidy --dry-run     # list candidates and kept branches; change nothing
git tidy --no-fetch    # use the remote-tracking refs you already have
git tidy --remote up   # compare against another remote (default: origin)
git tidy --stale-after "6 months"   # stale threshold for this run; "never" turns it off
git tidy -h
```

`git tidy --help` is caught by Git, which looks for a man page. Use `-h`.

`--dry-run` prints plain text. It works without a terminal or gum. Without
`--dry-run`, the tool needs a terminal and gum: run `make ensure-gum` in the
bootstrap clone.

## Requirements and tests

Node.js **24+**, the same as [git-ai](../git-ai/README.md). The process, error
and gum helpers come from [`tools/shared`](../shared/README.md). There are no npm
dependencies.

```sh
make test-git-tidy
```

The tests build temporary repositories, each with a bare origin, and use a fake
gum. They never touch your real Git config or remotes.
