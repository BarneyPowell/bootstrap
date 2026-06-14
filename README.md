# bootstrap

Personal, public-safe machine bootstrap script.

This repo sets up a shell/dev environment without hard-coding a username, hostname, or private values. It is intended for my own machines and accounts, but should be safe to run as any normal user.

## What it does

Current v1 setup:

- Detects macOS, Linux, and WSL-ish environments
- Bootstraps `gum` early where possible, then uses it for nicer confirmations and styled output
- Checks/installs Homebrew where appropriate
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

Inspect before running:

```sh
curl -fsSLO https://raw.githubusercontent.com/BarneyPowell/bootstrap/main/install.sh
less install.sh
bash install.sh --dry-run
bash install.sh
```

## One-liner usage

```sh
curl -fsSL https://raw.githubusercontent.com/BarneyPowell/bootstrap/main/install.sh | bash
```

For non-interactive setup:

```sh
curl -fsSL https://raw.githubusercontent.com/BarneyPowell/bootstrap/main/install.sh | bash -s -- --yes
```

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
