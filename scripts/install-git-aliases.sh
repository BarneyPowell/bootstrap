#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
aliases_file="$repo_dir/files/git-aliases.gitconfig"

# Keep other global settings and includes intact, and add our include only once.
if ! git config --global --get-all include.path | grep -qxF -- "$aliases_file"; then
  git config --global --add include.path "$aliases_file"
  printf 'Included Git aliases from %s\n' "$aliases_file"
fi
