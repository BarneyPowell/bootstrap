.PHONY: help install install-commands install-git ensure-gum test test-shared test-git-ai test-git-tidy test-qq check

help:
	@echo 'make install      install repository-managed configuration and commands'
	@echo 'make install-commands  symlink custom commands (git-*, qq) into ~/.local/bin'
	@echo 'make ensure-gum   offer to install gum for the terminal UI'
	@echo 'make check        run ShellCheck on all shell scripts'
	@echo 'make test-shared   run tests for helpers shared by the tools'
	@echo 'make test-git-ai   run isolated git-ai tests (no live inference)'
	@echo 'make test-git-tidy run isolated git-tidy tests (temporary repositories only)'
	@echo 'make test-qq      run isolated qq tests (fake providers only)'
	@echo 'make test         run every test suite'

install: install-commands

install-commands: ensure-gum
	@bash scripts/install-commands.sh

# Former name, kept so existing habits keep working.
install-git: install-commands

ensure-gum:
	@bash scripts/ensure-gum.sh

check:
	@shellcheck install.sh scripts/*.sh scripts/git/git-* scripts/bin/*

test-git-ai:
	@cd tools/git-ai && node --test test/*.test.ts

test-git-tidy:
	@cd tools/git-tidy && node --test test/*.test.ts

test-qq:
	@cd tools/qq && node --test test/*.test.ts

test: test-shared test-git-ai test-git-tidy test-qq

test-shared:
	@cd tools/shared && node --test test/*.test.ts
