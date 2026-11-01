#!/usr/bin/env bash
set -euo pipefail

preference_file="${XDG_STATE_HOME:-$HOME/.local/state}/bootstrap/gum-no-prompt"

if command -v gum >/dev/null 2>&1; then
  exit 0
fi

if [[ -f "$preference_file" ]]; then
  exit 0
fi

# Unattended installs continue with plain output and leave the preference alone.
if [[ ! -t 0 ]]; then
  printf 'gum is unavailable; continuing with plain output. Run make ensure-gum in a terminal to install it.\n'
  exit 0
fi

printf 'gum provides a nicer terminal UI. It is not currently installed.\n'
PS3='Choose an option (1-3): '
select choice in "Install gum" "Skip for now" "Skip and don't ask again"; do
  case "$choice" in
    'Install gum')
      if ! command -v brew >/dev/null 2>&1; then
        printf 'Automatic gum installation requires Homebrew. Install gum with your package manager, then rerun make install.\n' >&2
        exit 1
      fi
      brew install gum
      break
      ;;
    'Skip for now')
      break
      ;;
    "Skip and don't ask again")
      mkdir -p "$(dirname -- "$preference_file")"
      touch "$preference_file"
      break
      ;;
    *)
      printf 'Please enter 1, 2, or 3.\n' >&2
      ;;
  esac
done
