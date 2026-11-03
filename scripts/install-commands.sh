#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
bin_dir="$HOME/.local/bin"
zshrc="${ZDOTDIR:-$HOME}/.zshrc"

# Custom Git commands (git-*) and standalone commands, all linked into ~/.local/bin.
commands=("$repo_dir"/scripts/git/git-* "$repo_dir"/scripts/bin/*)

# Check every destination before making changes. Never replace unrelated files.
for source in "${commands[@]}"; do
  [[ -f "$source" ]] || continue
  if [[ ! -x "$source" ]]; then
    printf 'Not executable: %s (run chmod +x on the script first)\n' "$source" >&2
    exit 1
  fi
  destination="$bin_dir/${source##*/}"
  if [[ -e "$destination" || -L "$destination" ]]; then
    if [[ ! -L "$destination" || "$(readlink "$destination")" != "$source" ]]; then
      printf 'Cannot install: %s already exists; move it aside and rerun make install.\n' "$destination" >&2
      exit 1
    fi
  fi
done

mkdir -p "$bin_dir"
for source in "${commands[@]}"; do
  [[ -f "$source" ]] || continue
  destination="$bin_dir/${source##*/}"
  if [[ ! -L "$destination" ]]; then
    ln -s "$source" "$destination"
    printf 'Linked %s\n' "$destination"
  fi
done

# Reuse the PATH setting from the legacy installer when it is already present.
# Match the literal shell configuration, without expanding this process's PATH.
# shellcheck disable=SC2016
path_setting='  export PATH="$HOME/.local/bin:$PATH"'
if ! grep -qxF "$path_setting" "$zshrc" 2>/dev/null; then
  mkdir -p "$(dirname -- "$zshrc")"
  cat >> "$zshrc" <<'ZSH'

# Custom commands installed by the bootstrap repository.
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi
ZSH
fi

# zsh treats ? and * in an unquoted question as globs and stops with "no matches
# found" before qq runs. noglob passes them through as typed.
qq_alias="alias qq='noglob qq'"
if ! grep -qxF "$qq_alias" "$zshrc" 2>/dev/null; then
  cat >> "$zshrc" <<'ZSH'

# qq (bootstrap repository): pass ? and * in questions through unexpanded.
alias qq='noglob qq'
ZSH
  printf 'Added the qq noglob alias to %s\n' "$zshrc"
fi

# Print a command for the user to run, keeping its variables literal.
# shellcheck disable=SC2016
printf 'Commands installed. If needed, reload your shell with: exec zsh (or export PATH="$HOME/.local/bin:$PATH")\n'
