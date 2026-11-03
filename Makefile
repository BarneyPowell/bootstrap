.PHONY: help install install-commands install-git-aliases install-git ensure-gum test test-shared test-git-ai test-git-tidy test-git-wt test-qq check lint lint-ts lint-shell ci

SHELL_SCRIPTS := install.sh $(wildcard scripts/*.sh scripts/git/git-* scripts/bin/*)
BIN := node_modules/.bin

help:
	@echo 'make install      install repository-managed configuration and commands'
	@echo 'make install-commands  symlink custom commands (git-*, qq) into ~/.local/bin'
	@echo 'make install-git-aliases  include repository-managed Git aliases globally'
	@echo 'make ensure-gum   offer to install gum for the terminal UI'
	@echo 'make lint         type-check and lint TypeScript, lint shell scripts (npm ci first)'
	@echo 'make lint-ts      type-check with tsc and lint with oxlint'
	@echo 'make lint-shell   run ShellCheck and shfmt (check only) on shell scripts'
	@echo 'make check        same as make lint-shell'
	@echo 'make ci           run make lint, then make test'
	@echo 'make test-shared   run tests for helpers shared by the tools'
	@echo 'make test-git-ai   run isolated git-ai tests (no live inference)'
	@echo 'make test-git-tidy run isolated git-tidy tests (temporary repositories only)'
	@echo 'make test-git-wt  run isolated git-wt tests (temporary repositories only)'
	@echo 'make test-qq      run isolated qq tests (fake providers only)'
	@echo 'make test         run every test suite'

install: install-commands install-git-aliases

install-git-aliases:
	@bash scripts/install-git-aliases.sh

install-commands: ensure-gum
	@bash scripts/install-commands.sh

# Former name, kept so existing habits keep working.
install-git: install-commands

ensure-gum:
	@bash scripts/ensure-gum.sh

lint: lint-ts lint-shell

lint-ts:
	@test -x $(BIN)/tsc || { echo 'Missing dev tools: run npm ci first.' >&2; exit 1; }
	@$(BIN)/tsc -p .
	@$(BIN)/oxlint --type-aware --deny-warnings tools

lint-shell:
	@command -v shellcheck >/dev/null && command -v shfmt >/dev/null || { echo 'Install shellcheck and shfmt (brew bundle, or apt install shellcheck shfmt).' >&2; exit 1; }
	@shellcheck $(SHELL_SCRIPTS)
	@shfmt -d $(SHELL_SCRIPTS)

# Former name for the shell checks.
check: lint-shell

ci: lint test

test-git-ai:
	@cd tools/git-ai && node --test test/*.test.ts

test-git-tidy:
	@cd tools/git-tidy && node --test test/*.test.ts

test-git-wt:
	@cd tools/git-wt && node --test test/*.test.ts

test-qq:
	@cd tools/qq && node --test test/*.test.ts

test: test-shared test-git-ai test-git-tidy test-git-wt test-qq

test-shared:
	@cd tools/shared && node --test test/*.test.ts
