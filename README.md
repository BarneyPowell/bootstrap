# bootstrap

[![CI](https://github.com/BarneyPowell/bootstrap/actions/workflows/ci.yml/badge.svg)](https://github.com/BarneyPowell/bootstrap/actions/workflows/ci.yml)

Personal, public-safe machine bootstrap script.

This repo sets up a shell/dev environment without hard-coding a username, hostname, or private values. It is intended for my own machines and accounts, but should be safe to run as any normal user.

## What it does

Current v1 setup:

- Shows a friendly pre-flight banner before making changes, including the installer version, detected environment, installed tools, and planned actions
- Detects macOS, Linux, and WSL-ish environments
- Bootstraps `gum` early where possible, then uses it for nicer confirmations and styled output
  - macOS: installs via Homebrew when available
  - Debian/Raspberry Pi OS/WSL: uses apt if `gum` exists there, otherwise installs the official Linux release to `~/.local/bin`
- Checks/installs Homebrew on macOS only; Linux installs do not prompt for Homebrew
- Installs core command line tools when Homebrew is available:
  - `git`, `gh`, `jq`, `ripgrep`, `fd`, `fzf`, `bat`, `eza`, `zoxide`, `direnv`, `starship`
- Asks about optional tools:
  - formulae: `uv`, `node`
  - macOS casks: `codex`
- Installs Starship
- Installs Oh My Zsh if missing
- Installs/configures `zsh` on Debian/Raspberry Pi OS/WSL via apt when missing, and asks before changing the login shell
- Installs a Nerd Font on macOS via Homebrew Cask
- Copies `files/starship.toml` to `~/.config/starship.toml`, backing up an existing file first
- Adds a managed Starship block to `~/.zshrc`
- Disables the Oh My Zsh theme so Starship owns the prompt

The script is designed to be idempotent: running it repeatedly should not duplicate config blocks.

## Safer usage

### Custom Git commands from a local clone

Clone the `stable` branch, which always holds the latest release, then install:

```sh
git clone -b stable https://github.com/BarneyPowell/bootstrap.git
cd bootstrap
make install
git hello
```

Run `git pull` in the clone to update to a newer release; the installed commands
are symlinks into it, so they update too. To pin a release instead, clone its tag:

<!-- x-release-please-start-version -->
```sh
git clone -b v1.3.0 https://github.com/BarneyPowell/bootstrap.git
```
<!-- x-release-please-end -->

Clone `main` for the latest development version.

The Makefile installs custom commands and Git aliases. The broader shell setup
described below still uses the legacy `install.sh`.

Before installing commands, the `ensure-gum` prerequisite checks for `gum`.
If it is missing, an interactive menu offers to install it through Homebrew,
skip it for this run, or skip it and stop asking. The last choice is saved in
`${XDG_STATE_HOME:-~/.local/state}/bootstrap/gum-no-prompt`; delete that file to
enable the prompt again. Unattended runs skip the prompt without saving a choice.
You can also run this check separately with `make ensure-gum`.

`make install` symlinks executable `scripts/git/git-*` and `scripts/bin/*` files
into `~/.local/bin` and ensures zsh adds that directory to `PATH`. In an existing terminal that does
not already include it, run `export PATH="$HOME/.local/bin:$PATH"` first, or open
a new terminal.

Git discovers these commands automatically: `scripts/git/git-hello` becomes
`git hello`. Add another executable script with the `git-` prefix and rerun
`make install` (or `make install-commands`). Standalone commands such as `qq`
live in `scripts/bin/`. Edits to linked scripts take effect
immediately. Keep the clone in place so the symlinks continue to work.

Repeated installs leave correct links alone. Conflicting files are reported
without being overwritten; move them aside before retrying.

### Git aliases

Store Git aliases in `files/git-aliases.gitconfig` under `[alias]`.
`make install` (or `make install-git-aliases`) adds a global Git include for that
file, leaving other settings intact. Repeated installs do not duplicate the
include. Edits to the aliases take effect immediately; keep the clone in place.

The first alias is `git rebase-main`: it fetches `origin`, then rebases the
current branch onto `origin/main` with `--autostash` to temporarily stash
uncommitted changes and reapply them afterwards. Rebase or stash conflicts may
need manual resolution. It assumes the remote is named `origin` and the branch
is named `main`.

### AI-assisted commit messages

`make install` also exposes `git ai commit`: it proposes a Conventional Commits
message for staged changes and opens Git's editor for review.
Add `--yolo` to commit the proposal without reviewing it. See the
[git-ai guide](tools/git-ai/README.md) for runtime/build requirements, providers,
configuration, privacy, tests, and editor acceptance/abort behaviour.
Use `git ai ollama models` for a gum picker that saves your global default
Ollama model without changing provider order.
`git ai codex models` does the same for the explicit `ai.codex.model` default.
`git ai claude models` selects the `ai.claude.model` preference through the same UI.
When local context is too small, `ai.commit.contextFallback` can ask through gum
or automatically try Codex, subject to cloud permission and an explicit model.

### Tidy merged branches

`git tidy` finds the local branches whose upstream is already merged into the
remote's main branch (or was deleted on the remote after a merge). It shows them
in a gum table. You select the branches to delete and confirm. It can then also
delete the merged branches on the remote; you opt in to this and confirm it
separately. It also lists stale branches, which have had no activity for 90
days (set this with `git config tidy.staleAfter`). It offers to delete them, but
none start selected. Run `git tidy --dry-run` to list the branches without
changing anything. See the [git-tidy guide](tools/git-tidy/README.md) for the safety
rules.

### Worktree per branch

`git wt <branch>` checks out a branch in a sibling worktree and prints its path,
so `cd "$(git wt feature/ABC-123_name)"` puts you in it. A branch on origin is
fetched and tracked. A branch that is new is created from origin's default
branch, after a confirmation. It works with bare clones (`root/.bare`) and
normal checkouts (`root/repo`). See the [git-wt guide](tools/git-wt/README.md).

### Ship the live branch

Small changes, such as settings or new aliases, can go straight onto the `live`
branch. When you want them on `main`, run:

```sh
git live            # push live, open a PR into main, and auto-merge it when CI passes
git live --review   # the same, but leave the PR for you to merge
```

The PR merges with a merge commit, not a squash, so `main` then contains all of
`live`. The [Sync live](.github/workflows/sync-live.yml) workflow then
fast-forwards `live` to `main`, so `live` never needs merging by hand. Run
`git pull` on `live` before you add more. See the
[git-live guide](tools/git-live/README.md).

### Quick questions

`qq` asks an AI provider one question and prints the answer, formatted with gum:

```sh
qq How do I see all the members of a group in linux?
qq                                  # type the question at a prompt
make 2>&1 | qq why did this fail    # piped text becomes context
```

It uses the same providers and Git settings as `git ai`. `qq.providers`
optionally sets its own order. `make install` also adds `alias qq='noglob qq'` to
`~/.zshrc`, so zsh does not treat `?` and `*` in a question as filename patterns.
See the [qq guide](tools/qq/README.md) for setup and for what is sent.

### Legacy installer usage

Use a version tag for repeatable installs. `v1` always means the latest v1.x installer:

```sh
curl -fsSLO https://raw.githubusercontent.com/BarneyPowell/bootstrap/v1/install.sh
less install.sh
bash install.sh --dry-run
bash install.sh
```

## One-liner usage

Stable v1:

```sh
curl -fsSL https://raw.githubusercontent.com/BarneyPowell/bootstrap/v1/install.sh | bash
```

Latest from `main`:

```sh
curl -fsSL https://raw.githubusercontent.com/BarneyPowell/bootstrap/main/install.sh | bash
```

For non-interactive stable v1 setup:

```sh
curl -fsSL https://raw.githubusercontent.com/BarneyPowell/bootstrap/v1/install.sh | bash -s -- --yes
```

## Versioning strategy

Releases follow [Semantic Versioning](https://semver.org/), worked out from the
[Conventional Commits](https://www.conventionalcommits.org/) on `main`: `fix:`
makes a patch release, `feat:` a minor one, and a `!` (such as `feat!:`) or a
`BREAKING CHANGE:` footer a major one.

| Want | Use |
| --- | --- |
| The latest release, updated with `git pull` | the `stable` branch |
| The latest v1.x installer | the `v1` tag |
| The latest v1.3.x installer | the `v1.3` tag |
| One exact release, never changing | an exact tag, such as `v1.3.0` |
| The latest development version | `main` |

Exact tags never move. `v1` and `v1.3` move to each new matching release, and
`stable` fast-forwards to every release. When `install.sh` is piped from curl, it
fetches its other files from its own release, not from `main`.

Examples:

<!-- x-release-please-start-version -->
```sh
# Latest v1.x
curl -fsSL https://raw.githubusercontent.com/BarneyPowell/bootstrap/v1/install.sh | bash

# Exactly v1.3.0
curl -fsSL https://raw.githubusercontent.com/BarneyPowell/bootstrap/v1.3.0/install.sh | bash
```
<!-- x-release-please-end -->

### Releases

The [Release workflow](.github/workflows/release.yml) runs
[release-please](https://github.com/googleapis/release-please) on every push to
`main`. It keeps a release pull request open, which:

- bumps the version in `version.txt`, `install.sh` and this README;
- adds the release's `feat` and `fix` commits to `CHANGELOG.md`.

To release, merge that pull request (a squash is fine). The workflow then tags
`vX.Y.Z`, creates a GitHub Release, moves the floating tags with
`scripts/update-floating-tags.sh`, and fast-forwards `stable`. Until you merge
it, new commits on `main` just update the pull request.

The workflow needs a token that isn't the workflow's own, because pull requests
opened with that token don't run CI, so the release pull request's required
checks would never report. Either:

- **Fine-grained personal access token:** create one for this repository only,
  with read and write access to Contents, Issues and Pull requests, and save it
  as the `RELEASE_TOKEN` secret (`gh secret set RELEASE_TOKEN`). Renew it before
  it expires.
- **GitHub App:** create an app with the same permissions, install it on this
  repository only, then add its ID as the `RELEASE_APP_ID` variable and its
  private key as the `RELEASE_APP_PRIVATE_KEY` secret. It doesn't expire. When
  the app is configured, the workflow uses it instead of `RELEASE_TOKEN`.

If a release ever needs fixing by hand, `scripts/update-floating-tags.sh --push`
recomputes the floating tags from the exact ones. Moving floating tags needs a
tag force-push by design; exact tags should never move once published.

## Options

```text
-y, --yes            Assume yes for prompts
-n, --dry-run        Print actions without making changes
--no-brew            Skip Homebrew install/check
--no-tools           Skip CLI tool installation
--no-omz             Skip Oh My Zsh install/check
--no-starship        Skip Starship install/config
--no-fonts           Skip Nerd Font installation
--no-optional        Skip optional tools instead of asking
--no-chsh            Do not offer to change the user's login shell
-h, --help           Show help
```

## Developer scripts

Update floating version tags locally from exact patch tags:

```sh
scripts/update-floating-tags.sh --dry-run
scripts/update-floating-tags.sh
scripts/update-floating-tags.sh --push
```

This keeps tags like `v1` and `v1.2` pointed at the latest exact patch tag in their version class. It is intended for local release maintenance, not for end-user installs.

### Checks

```sh
npm ci       # once, to install the dev tools (installing commands does not need this)
make lint    # type-check, lint and format-check the TypeScript and shell scripts
make fmt     # format the TypeScript (oxfmt) and shell scripts (shfmt) in place
make test    # run every test suite
make ci      # make lint, then make test
```

- `make lint-ts` type-checks the tools with `tsc` (TypeScript checks only; Node
  still runs the `.ts` files directly) and lints them with oxlint, including
  type-aware rules such as unawaited promises. Lint warnings fail the check.
  It also checks formatting with oxfmt. Configuration is in `tsconfig.json`,
  `.oxlintrc.json` and `.oxfmtrc.json`.
- `make lint-shell` runs ShellCheck and checks shell formatting with `shfmt -d`.
  Both come from the Brewfile; on Debian, `apt install shellcheck shfmt`.
- `make fmt` applies both formatters; `make fmt-check` checks without writing.
  oxfmt and shfmt both read `.editorconfig` (indentation, and `case` indentation
  for shfmt), so editors and formatters agree. In VS Code, the recommended
  extensions format TypeScript on save.
- The TypeScript was reformatted in one commit when oxfmt was adopted. To have
  `git blame` skip it and show who last changed each line's code, run
  `git config blame.ignoreRevsFile .git-blame-ignore-revs` once. GitHub's blame
  view reads that file automatically.
- `make lint-workflows` runs actionlint on `.github/workflows`. It is not part of
  `make lint`, because actionlint is not packaged everywhere (`brew install
  actionlint`, or `go install`).

CI (`.github/workflows/ci.yml`) runs on every pull request and push to `main`, on
Ubuntu, in three jobs that each run only when their files change:

| Job | Runs | When these change |
| --- | --- | --- |
| `typescript` | `make lint-ts`, then every test suite (Node 24) | `tools/`, `scripts/git/`, `scripts/bin/`, npm, TypeScript or oxlint config |
| `shell` | `make lint-shell` | `install.sh`, `scripts/`, `.editorconfig` |
| `actionlint` | `make lint-workflows` | `.github/workflows/` |

Markdown files never trigger a job. A change to the `Makefile` runs `typescript`
and `shell`; a change to `ci.yml`, or a manual run, runs all three. A `changes`
job decides which jobs run; if it fails, every job runs.

## Notes

- `--yes` answers yes to all prompts, including optional tools and login-shell changes. Use `--yes --no-optional --no-chsh` if you want unattended core setup only.
- Font installation matters on the client machine where the terminal renders. It does not need to be installed on remote SSH servers unless they have their own GUI terminal.
- Private config should live in local-only files such as `~/.zshrc.local` or `~/.gitconfig.local`, not in this public repo.
- This script avoids replacing whole dotfiles. It appends/updates clearly marked managed blocks and makes timestamped backups before changing existing files.
