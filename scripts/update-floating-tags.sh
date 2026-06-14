#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
PUSH=0
REMOTE="origin"

usage() {
  cat <<'USAGE'
Usage: scripts/update-floating-tags.sh [options]

Update floating version tags from exact semantic version tags.

Exact patch tags are immutable release tags, e.g.:
  v1.2.0
  v1.2.1

Floating tags are intentionally movable convenience tags:
  v1    -> latest v1.x.x
  v1.2  -> latest v1.2.x

Options:
  -n, --dry-run        Show what would change without changing tags
      --push           Push changed floating tags to the remote with --force
      --remote NAME    Remote to push to when --push is set (default: origin)
  -h, --help           Show this help

Examples:
  scripts/update-floating-tags.sh --dry-run
  scripts/update-floating-tags.sh
  scripts/update-floating-tags.sh --push
USAGE
}

log() { printf '==> %s\n' "$*"; }
warn() { printf 'warn: %s\n' "$*" >&2; }
err() { printf 'error: %s\n' "$*" >&2; }

run() {
  if [[ "$DRY_RUN" == 1 ]]; then
    printf 'DRY-RUN: '
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

semver_sort() {
  # Sort tags like v1.2.10 correctly after v1.2.9.
  sort -t. -k1,1V -k2,2n -k3,3n
}

exact_tags() {
  git tag --list 'v[0-9]*.[0-9]*.[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | semver_sort
}

latest_exact_for_major() {
  local major="$1"
  exact_tags | grep -E "^v${major//v/}\.[0-9]+\.[0-9]+$" | tail -n 1
}

latest_exact_for_minor() {
  local minor="$1"
  exact_tags | grep -E "^${minor//./\.}\.[0-9]+$" | tail -n 1
}

point_tag_at() {
  local floating_tag="$1"
  local exact_tag="$2"
  local target_commit current_commit

  if [[ -z "$exact_tag" ]]; then
    warn "No exact patch tag found for $floating_tag; skipping"
    return
  fi

  target_commit="$(git rev-list -n 1 "$exact_tag")"
  current_commit=""
  if git rev-parse -q --verify "refs/tags/$floating_tag" >/dev/null; then
    current_commit="$(git rev-list -n 1 "$floating_tag")"
  fi

  if [[ "$current_commit" == "$target_commit" ]]; then
    log "$floating_tag already points at $exact_tag ($target_commit)"
    return
  fi

  log "Pointing $floating_tag at $exact_tag ($target_commit)"
  run git tag -fa "$floating_tag" "$target_commit" -m "$floating_tag: latest ${floating_tag#v}.x stable release"

  if [[ "$PUSH" == 1 ]]; then
    run git push --force "$REMOTE" "$floating_tag"
  fi
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -n|--dry-run) DRY_RUN=1 ;;
      --push) PUSH=1 ;;
      --remote)
        shift
        if [[ $# -eq 0 ]]; then
          err "--remote requires a value"
          exit 2
        fi
        REMOTE="$1"
        ;;
      -h|--help) usage; exit 0 ;;
      *) err "Unknown option: $1"; usage; exit 2 ;;
    esac
    shift
  done

  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    err "Run this from inside the bootstrap git repo"
    exit 1
  fi

  log "Fetching tags"
  run git fetch --tags "$REMOTE"

  local tags
  tags="$(exact_tags || true)"
  if [[ -z "$tags" ]]; then
    err "No exact patch tags found, e.g. v1.2.0"
    exit 1
  fi

  log "Exact patch tags found:"
  printf '%s\n' "$tags" | sed 's/^/  - /'

  local major minor latest

  # Update floating major tags: v1, v2, ...
  while read -r major; do
    [[ -n "$major" ]] || continue
    latest="$(latest_exact_for_major "$major")"
    point_tag_at "$major" "$latest"
  done < <(printf '%s\n' "$tags" | sed -E 's/^(v[0-9]+)\..*/\1/' | sort -uV)

  # Update floating minor tags: v1.0, v1.1, v1.2, ...
  while read -r minor; do
    [[ -n "$minor" ]] || continue
    latest="$(latest_exact_for_minor "$minor")"
    point_tag_at "$minor" "$latest"
  done < <(printf '%s\n' "$tags" | sed -E 's/^(v[0-9]+\.[0-9]+)\..*/\1/' | sort -uV)

  if [[ "$PUSH" != 1 ]]; then
    warn "Local tags updated only. Re-run with --push to force-push floating tags."
  fi
}

main "$@"
