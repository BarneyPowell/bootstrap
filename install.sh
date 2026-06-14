#!/usr/bin/env bash
set -euo pipefail

# Personal bootstrap script.
# Public-safe: no hard-coded usernames, hostnames, secrets, or private paths.

BOOTSTRAP_REPO_RAW="https://raw.githubusercontent.com/BarneyPowell/bootstrap/main"
if [[ -n "${BASH_SOURCE[0]-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
else
  SCRIPT_DIR=""
fi

ASSUME_YES=0
DRY_RUN=0
DO_BREW=1
DO_TOOLS=1
DO_OMZ=1
DO_STARSHIP=1
DO_FONTS=1
DO_OPTIONAL=1
DO_CHSH=1
GUM_EARLY_ATTEMPTED=0

BREW_CORE_PACKAGES=(
  git
  gh
  jq
  ripgrep
  fd
  fzf
  bat
  eza
  zoxide
  direnv
  starship
)

BREW_OPTIONAL_PACKAGES=(
  uv
  node
)

# Optional Homebrew casks. Casks are macOS-only in this script.
BREW_OPTIONAL_CASKS=(
  codex
)

MACOS_FONT_CASKS=(
  font-fira-code-nerd-font
  font-jetbrains-mono-nerd-font
)

GUM_VERSION="0.17.0"

usage() {
  cat <<'USAGE'
Usage: bash install.sh [options]

Options:
  -y, --yes            Assume yes for prompts
  -n, --dry-run        Print actions without making changes
      --no-brew        Skip Homebrew install/check
      --no-tools       Skip CLI tool installation
      --no-omz         Skip Oh My Zsh install/check
      --no-starship    Skip Starship install/config
      --no-fonts       Skip Nerd Font installation
      --no-optional    Skip optional tools instead of asking
      --no-chsh        Do not offer to change the user's login shell
  -h, --help           Show this help
USAGE
}

log() {
  if command_exists gum; then
    gum style --foreground 39 --bold "==> $*"
  else
    printf '\033[1;34m==>\033[0m %s\n' "$*"
  fi
}

warn() {
  if command_exists gum; then
    gum style --foreground 214 --bold "warn: $*" >&2
  else
    printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2
  fi
}

err() {
  if command_exists gum; then
    gum style --foreground 196 --bold "error: $*" >&2
  else
    printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
  fi
}

run() {
  if [[ "$DRY_RUN" == 1 ]]; then
    printf 'DRY-RUN: '
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

run_shell() {
  if [[ "$DRY_RUN" == 1 ]]; then
    printf 'DRY-RUN: %s\n' "$*"
  else
    bash -c "$*"
  fi
}

command_exists() { command -v "$1" >/dev/null 2>&1; }

ask() {
  local prompt="$1"
  if [[ "$ASSUME_YES" == 1 ]]; then
    log "$prompt yes"
    return 0
  fi

  if command_exists gum && [[ -r /dev/tty ]]; then
    gum confirm "$prompt" </dev/tty
    return $?
  fi

  if [[ -r /dev/tty ]]; then
    printf '%s [y/N] ' "$prompt" >/dev/tty
    local reply
    read -r reply </dev/tty || true
    case "$reply" in
      y|Y|yes|YES) return 0 ;;
      *) return 1 ;;
    esac
  fi

  warn "No interactive terminal available; defaulting to no for: $prompt"
  return 1
}

backup_file() {
  local path="$1"
  if [[ -f "$path" ]]; then
    local backup="${path}.bak.$(date +%Y%m%d%H%M%S)"
    log "Backing up $path to $backup"
    run cp "$path" "$backup"
  fi
}

os_name() {
  case "$(uname -s)" in
    Darwin) printf 'macos' ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        printf 'wsl'
      else
        printf 'linux'
      fi
      ;;
    *) printf 'unknown' ;;
  esac
}

apt_available() {
  command_exists apt-get
}

apt_has_package() {
  local pkg="$1"
  command_exists apt-cache && apt-cache show "$pkg" >/dev/null 2>&1
}

install_gum_from_github_release() {
  local os arch asset url tmpdir
  os="$(os_name)"
  if [[ "$os" != "linux" && "$os" != "wsl" ]]; then
    return 1
  fi

  case "$(uname -m)" in
    x86_64|amd64) arch="x86_64" ;;
    aarch64|arm64) arch="arm64" ;;
    armv7l) arch="armv7" ;;
    armv6l) arch="armv6" ;;
    i386|i686) arch="i386" ;;
    *)
      warn "Unsupported architecture for gum release install: $(uname -m)"
      return 1
      ;;
  esac

  asset="gum_${GUM_VERSION}_Linux_${arch}.tar.gz"
  url="https://github.com/charmbracelet/gum/releases/download/v${GUM_VERSION}/${asset}"

  log "Installing gum ${GUM_VERSION} from GitHub release"
  if [[ "$DRY_RUN" == 1 ]]; then
    printf 'DRY-RUN: download %s and install gum to %s/.local/bin/gum\n' "$url" "$HOME"
    return 0
  fi

  tmpdir="$(mktemp -d)"
  curl -fsSL "$url" -o "$tmpdir/gum.tar.gz"
  tar -xzf "$tmpdir/gum.tar.gz" -C "$tmpdir"
  mkdir -p "$HOME/.local/bin"
  find "$tmpdir" -type f -name gum -perm -111 -exec cp {} "$HOME/.local/bin/gum" \; -quit
  rm -rf "$tmpdir"
  chmod +x "$HOME/.local/bin/gum"
  export PATH="$HOME/.local/bin:$PATH"
}

run_sudo() {
  if [[ "$(id -u)" == 0 ]]; then
    run "$@"
  else
    run sudo "$@"
  fi
}

apt_install_packages() {
  if ! apt_available; then
    return 1
  fi

  run_sudo apt-get update
  run_sudo apt-get install -y "$@"
}

ensure_gum_early() {
  if [[ "$DO_TOOLS" != 1 ]]; then
    return
  fi

  if command_exists gum; then
    return
  fi

  if [[ "$GUM_EARLY_ATTEMPTED" == 1 ]] && ! command_exists brew; then
    return
  fi
  GUM_EARLY_ATTEMPTED=1

  log "gum not found; trying to install it early for a nicer setup UI"

  ensure_brew_shellenv
  if command_exists brew; then
    log "Installing gum with Homebrew"
    run brew install gum
    return
  fi

  case "$(os_name)" in
    linux|wsl)
      if ask "Install gum for nicer setup prompts?"; then
        if apt_available && apt_has_package gum; then
          if apt_install_packages gum; then
            return
          fi
          warn "apt could not install gum; trying GitHub release fallback"
        fi

        if install_gum_from_github_release; then
          return
        fi

        warn "gum install failed; continuing with plain prompts"
        return
      fi
      ;;
  esac

  warn "gum unavailable; continuing with plain prompts"
}

ensure_zsh() {
  if command_exists zsh; then
    log "zsh already installed: $(command -v zsh)"
  else
    case "$(os_name)" in
      linux|wsl)
        if apt_available && ask "Install zsh with apt?"; then
          apt_install_packages zsh
        else
          warn "zsh not installed; skipping zsh install"
          return
        fi
        ;;
      macos)
        ensure_brew_shellenv
        if command_exists brew && ask "Install zsh with Homebrew?"; then
          run brew install zsh
        else
          warn "zsh not installed; macOS usually includes /bin/zsh already"
          return
        fi
        ;;
      *)
        warn "Unsupported OS for zsh auto-install: $(os_name)"
        return
        ;;
    esac
  fi

  local zsh_path
  zsh_path="$(command -v zsh 2>/dev/null || true)"
  if [[ -z "$zsh_path" ]]; then
    warn "zsh still not found after install attempt"
    return
  fi

  if [[ "${SHELL:-}" == "$zsh_path" ]]; then
    log "Default shell is already zsh"
    return
  fi

  if [[ -f /etc/shells ]] && ! grep -qxF "$zsh_path" /etc/shells; then
    warn "$zsh_path is not listed in /etc/shells; chsh may fail"
    if ask "Add $zsh_path to /etc/shells?"; then
      if [[ "$DRY_RUN" == 1 ]]; then
        printf 'DRY-RUN: append %s to /etc/shells\n' "$zsh_path"
      else
        printf '%s\n' "$zsh_path" | sudo tee -a /etc/shells >/dev/null
      fi
    fi
  fi

  if [[ "$DO_CHSH" != 1 ]]; then
    warn "Skipping login shell change. You can try zsh now with: zsh"
    return
  fi

  if ask "Change default shell for $(id -un) to $zsh_path?"; then
    run chsh -s "$zsh_path"
    warn "You may need to log out and back in for the shell change to take effect"
  else
    warn "Default shell unchanged. You can try zsh now with: zsh"
  fi
}

brew_prefix_guess() {
  if command_exists brew; then
    brew --prefix
    return
  fi

  case "$(uname -m)" in
    arm64|aarch64) printf '/opt/homebrew' ;;
    *) printf '/usr/local' ;;
  esac
}

ensure_homebrew() {
  if [[ "$DO_BREW" != 1 ]]; then
    warn "Skipping Homebrew"
    return
  fi

  if command_exists brew; then
    log "Homebrew already installed: $(brew --prefix)"
    return
  fi

  local os
  os="$(os_name)"
  if [[ "$os" != "macos" ]]; then
    warn "Homebrew not found; not installing Homebrew on $os"
    return
  fi

  if ask "Install Homebrew?"; then
    run_shell '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  else
    warn "Homebrew not installed; skipping brew-managed packages"
  fi
}

ensure_brew_shellenv() {
  if command_exists brew; then
    return
  fi

  local prefix
  prefix="$(brew_prefix_guess)"
  if [[ -x "$prefix/bin/brew" ]]; then
    eval "$("$prefix/bin/brew" shellenv)"
  fi
}

install_brew_package() {
  local pkg="$1"
  if brew list --formula "$pkg" >/dev/null 2>&1; then
    log "$pkg already installed"
  else
    log "Installing $pkg"
    run brew install "$pkg"
  fi
}

install_brew_cask() {
  local cask="$1"
  if brew list --cask "$cask" >/dev/null 2>&1; then
    log "$cask already installed"
  else
    log "Installing $cask"
    run brew install --cask "$cask"
  fi
}

install_brew_packages() {
  if [[ "$DO_TOOLS" != 1 ]]; then
    warn "Skipping CLI tools"
    return
  fi

  ensure_brew_shellenv
  if ! command_exists brew; then
    warn "brew not found; cannot install CLI tools"
    return
  fi

  log "Updating Homebrew"
  run brew update

  log "Installing core CLI tools"
  for pkg in "${BREW_CORE_PACKAGES[@]}"; do
    install_brew_package "$pkg"
  done

  if [[ "$DO_OPTIONAL" != 1 ]]; then
    warn "Skipping optional CLI tools"
    return
  fi

  log "Optional CLI tools"
  for pkg in "${BREW_OPTIONAL_PACKAGES[@]}"; do
    if ask "Install optional formula '$pkg'?"; then
      install_brew_package "$pkg"
    else
      warn "Skipping optional formula: $pkg"
    fi
  done

  if [[ "$(os_name)" == "macos" ]]; then
    log "Optional macOS apps/casks"
    for cask in "${BREW_OPTIONAL_CASKS[@]}"; do
      if ask "Install optional cask '$cask'?"; then
        install_brew_cask "$cask"
      else
        warn "Skipping optional cask: $cask"
      fi
    done
  else
    warn "Skipping optional Homebrew casks: casks are macOS-only here"
  fi
}

install_fonts() {
  if [[ "$DO_FONTS" != 1 ]]; then
    warn "Skipping fonts"
    return
  fi

  if [[ "$(os_name)" != "macos" ]]; then
    warn "Skipping Nerd Fonts: install fonts on the terminal client machine"
    return
  fi

  ensure_brew_shellenv
  if ! command_exists brew; then
    warn "brew not found; cannot install fonts"
    return
  fi

  for cask in "${MACOS_FONT_CASKS[@]}"; do
    install_brew_cask "$cask"
  done
}

install_starship_without_brew() {
  if command_exists starship; then
    log "Starship already installed: $(starship --version | head -n1)"
    return
  fi

  local bin_dir="$HOME/.local/bin"
  log "Installing Starship to $bin_dir"
  run mkdir -p "$bin_dir"
  run_shell "curl -fsSL https://starship.rs/install.sh | sh -s -- -y -b '$bin_dir'"

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) warn "$bin_dir is not on PATH yet; the zsh config block will add it" ;;
  esac
}

ensure_omz() {
  if [[ "$DO_OMZ" != 1 ]]; then
    warn "Skipping Oh My Zsh"
    return
  fi

  if [[ -d "$HOME/.oh-my-zsh" ]]; then
    log "Oh My Zsh already installed"
    return
  fi

  if ask "Install Oh My Zsh?"; then
    run_shell 'RUNZSH=no CHSH=no KEEP_ZSHRC=yes sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"'
  else
    warn "Oh My Zsh not installed"
  fi
}

starship_config_source() {
  local local_file=""
  if [[ -n "$SCRIPT_DIR" ]]; then
    local_file="$SCRIPT_DIR/files/starship.toml"
  fi

  if [[ -n "$local_file" && -f "$local_file" ]]; then
    printf '%s' "$local_file"
  else
    printf '%s' "${BOOTSTRAP_REPO_RAW}/files/starship.toml"
  fi
}

install_starship_config() {
  if [[ "$DO_STARSHIP" != 1 ]]; then
    warn "Skipping Starship config"
    return
  fi

  run mkdir -p "$HOME/.config"
  local dest="$HOME/.config/starship.toml"
  local src
  src="$(starship_config_source)"

  if [[ -f "$src" ]]; then
    if [[ -f "$dest" ]] && cmp -s "$src" "$dest"; then
      log "Starship config already up to date"
    else
      backup_file "$dest"
      log "Installing Starship config to $dest"
      run cp "$src" "$dest"
    fi
  else
    backup_file "$dest"
    log "Downloading Starship config to $dest"
    if [[ "$DRY_RUN" == 1 ]]; then
      printf 'DRY-RUN: curl -fsSL %q -o %q\n' "$src" "$dest"
    else
      curl -fsSL "$src" -o "$dest"
    fi
  fi
}

ensure_zshrc() {
  local zshrc="$HOME/.zshrc"
  if [[ ! -f "$zshrc" ]]; then
    log "Creating $zshrc"
    run touch "$zshrc"
    if [[ "$DRY_RUN" == 1 ]]; then
      return
    fi
  fi

  # If Oh My Zsh is present, disable its theme so Starship owns the prompt.
  if grep -q '^ZSH_THEME=' "$zshrc"; then
    if ! grep -q '^ZSH_THEME=""' "$zshrc"; then
      backup_file "$zshrc"
      log "Disabling Oh My Zsh theme in $zshrc"
      if [[ "$DRY_RUN" == 1 ]]; then
        printf 'DRY-RUN: replace ZSH_THEME with ZSH_THEME="" in %s\n' "$zshrc"
      else
        perl -0pi -e 's/^ZSH_THEME=.*$/ZSH_THEME=""/m' "$zshrc"
      fi
    fi
  fi

  local start='# >>> bootstrap managed block >>>'
  local end='# <<< bootstrap managed block <<<'
  local block
  block="$(cat <<'BLOCK'
# >>> bootstrap managed block >>>
# Keep user-local binaries available, including Starship installed without sudo.
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac

# Starship prompt. Oh My Zsh can still manage plugins/completion; Starship owns prompt rendering.
if command -v starship >/dev/null 2>&1; then
  eval "$(starship init zsh)"
fi

# Optional machine-local/private shell config. Do not commit this file.
if [[ -f "$HOME/.zshrc.local" ]]; then
  source "$HOME/.zshrc.local"
fi
# <<< bootstrap managed block <<<
BLOCK
)"

  if grep -qF "$start" "$zshrc"; then
    log "Updating managed block in $zshrc"
    backup_file "$zshrc"
    if [[ "$DRY_RUN" == 1 ]]; then
      printf 'DRY-RUN: update managed block in %s\n' "$zshrc"
    else
      python3 - "$zshrc" "$start" "$end" "$block" <<'PY'
import sys
path, start, end, block = sys.argv[1:]
text = open(path, encoding='utf-8').read()
pre, rest = text.split(start, 1)
_, post = rest.split(end, 1)
open(path, 'w', encoding='utf-8').write(pre.rstrip() + "\n\n" + block + post)
PY
    fi
  else
    log "Adding managed block to $zshrc"
    backup_file "$zshrc"
    if [[ "$DRY_RUN" == 1 ]]; then
      printf 'DRY-RUN: append managed block to %s\n' "$zshrc"
    else
      printf '\n%s\n' "$block" >> "$zshrc"
    fi
  fi
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -y|--yes) ASSUME_YES=1 ;;
      -n|--dry-run) DRY_RUN=1 ;;
      --no-brew) DO_BREW=0 ;;
      --no-tools) DO_TOOLS=0 ;;
      --no-omz) DO_OMZ=0 ;;
      --no-starship) DO_STARSHIP=0 ;;
      --no-fonts) DO_FONTS=0 ;;
      --no-optional) DO_OPTIONAL=0 ;;
      --no-chsh) DO_CHSH=0 ;;
      -h|--help) usage; exit 0 ;;
      *) err "Unknown option: $1"; usage; exit 2 ;;
    esac
    shift
  done

  log "Bootstrap starting on $(os_name) / $(uname -m) as $(id -un)"

  ensure_gum_early
  ensure_homebrew
  ensure_gum_early
  install_brew_packages

  ensure_zsh

  if [[ "$DO_STARSHIP" == 1 ]]; then
    if ! command_exists starship; then
      install_starship_without_brew
    fi
    install_starship_config
  fi

  ensure_omz
  install_fonts
  ensure_zshrc

  log "Done. Restart your shell or run: exec zsh"
}

main "$@"
