# bootstrap

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

Use a version tag for repeatable installs. `v1.2` will always mean the latest v1.2.x installer:

```sh
curl -fsSLO https://raw.githubusercontent.com/BarneyPowell/bootstrap/v1.2/install.sh
less install.sh
bash install.sh --dry-run
bash install.sh
```

## One-liner usage

Stable v1.2:

```sh
curl -fsSL https://raw.githubusercontent.com/BarneyPowell/bootstrap/v1.2/install.sh | bash
```

Latest from `main`:

```sh
curl -fsSL https://raw.githubusercontent.com/BarneyPowell/bootstrap/main/install.sh | bash
```

For non-interactive stable v1.2 setup:

```sh
curl -fsSL https://raw.githubusercontent.com/BarneyPowell/bootstrap/v1.2/install.sh | bash -s -- --yes
```

## Versioning strategy

This repo uses Git tags to provide stable installer URLs.

Floating tags:

- `v1` points to the latest stable `v1.x` release.
- `v1.1` points to the latest stable `v1.1.x` release.

Exact release tags:

- `v1.1.0`, `v1.1.1`, etc. point to immutable patch releases.
- Use exact patch tags when you want a fully pinned installer.
- Use floating tags when you want compatible updates.

Examples:

```sh
# Latest stable v1.x
curl -fsSL https://raw.githubusercontent.com/BarneyPowell/bootstrap/v1/install.sh | bash

# Latest stable v1.1.x
curl -fsSL https://raw.githubusercontent.com/BarneyPowell/bootstrap/v1.1/install.sh | bash

# Exact immutable v1.1.0
curl -fsSL https://raw.githubusercontent.com/BarneyPowell/bootstrap/v1.1.0/install.sh | bash

# Latest development version
curl -fsSL https://raw.githubusercontent.com/BarneyPowell/bootstrap/main/install.sh | bash
```

Release process:

1. Commit changes to `main`.
2. Create an exact patch tag, e.g. `v1.1.1`.
3. Move the floating minor tag, e.g. `v1.1`, to the same commit.
4. Move the floating major tag, e.g. `v1`, to the same commit if it is the latest stable v1 release.
5. Create a GitHub release for the new version.

Moving floating tags requires a tag force-push by design; exact patch tags should not be moved after publication.

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

## Notes

- `--yes` answers yes to all prompts, including optional tools and login-shell changes. Use `--yes --no-optional --no-chsh` if you want unattended core setup only.
- Font installation matters on the client machine where the terminal renders. It does not need to be installed on remote SSH servers unless they have their own GUI terminal.
- Private config should live in local-only files such as `~/.zshrc.local` or `~/.gitconfig.local`, not in this public repo.
- This script avoids replacing whole dotfiles. It appends/updates clearly marked managed blocks and makes timestamped backups before changing existing files.
