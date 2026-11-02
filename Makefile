.PHONY: help install install-git ensure-gum test-shared test-git-ai test-git-tidy check

help:
	@echo 'make install      install repository-managed configuration and commands'
	@echo 'make install-git  symlink custom Git commands into ~/.local/bin'
	@echo 'make ensure-gum   offer to install gum for the terminal UI'
	@echo 'make check        run ShellCheck on all shell scripts'
	@echo 'make test-shared   run tests for helpers shared by the tools'
	@echo 'make test-git-ai   run isolated git-ai tests (no live inference)'
	@echo 'make test-git-tidy run isolated git-tidy tests (temporary repositories only)'

install: install-git

install-git: ensure-gum
	@bash scripts/install-git.sh

ensure-gum:
	@bash scripts/ensure-gum.sh

check:
	@shellcheck install.sh scripts/*.sh scripts/git/git-*

test-git-ai:
	@cd tools/git-ai && node --test test/*.test.ts

test-git-tidy:
	@cd tools/git-tidy && node --test test/*.test.ts

test-shared:
	@cd tools/shared && node --test test/*.test.ts
