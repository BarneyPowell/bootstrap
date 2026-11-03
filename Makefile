.PHONY: help install install-commands install-git-aliases install-git ensure-gum test test-shared test-git-ai test-git-tidy test-git-wt test-git-live test-qq check lint lint-ts lint-shell lint-workflows ci fmt fmt-check

SHELL_SCRIPTS := install.sh $(wildcard scripts/*.sh scripts/git/git-* scripts/bin/*)
BIN := node_modules/.bin
# Quoted so oxfmt, not the shell, expands the glob.
TS_FILES := 'tools/**/*.ts'
NEED_NPM = @test -x $(BIN)/tsc || { echo 'Missing dev tools: run npm ci first.' >&2; exit 1; }
NEED_SHELL_TOOLS = @command -v shellcheck >/dev/null && command -v shfmt >/dev/null || { echo 'Install shellcheck and shfmt (brew bundle, or apt install shellcheck shfmt).' >&2; exit 1; }

help:
	@echo 'make install      install repository-managed configuration and commands'
	@echo 'make install-commands  symlink custom commands (git-*, qq) into ~/.local/bin'
	@echo 'make install-git-aliases  include repository-managed Git aliases globally'
	@echo 'make ensure-gum   offer to install gum for the terminal UI'
	@echo 'make lint         type-check, lint and format-check everything (npm ci first)'
	@echo 'make lint-ts      type-check with tsc, lint with oxlint, check formatting with oxfmt'
	@echo 'make lint-shell   run ShellCheck and check formatting with shfmt'
	@echo 'make fmt          format TypeScript (oxfmt) and shell scripts (shfmt) in place'
	@echo 'make fmt-check    check formatting only, without writing'
	@echo 'make check        same as make lint-shell'
	@echo 'make lint-workflows  run actionlint on the GitHub Actions workflows'
	@echo 'make ci           run make lint, then make test'
	@echo 'make test-shared   run tests for helpers shared by the tools'
	@echo 'make test-git-ai   run isolated git-ai tests (no live inference)'
	@echo 'make test-git-tidy run isolated git-tidy tests (temporary repositories only)'
	@echo 'make test-git-wt  run isolated git-wt tests (temporary repositories only)'
	@echo 'make test-git-live run isolated git-live tests (temporary repositories, fake gh)'
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
	$(NEED_NPM)
	@$(BIN)/tsc -p .
	@$(BIN)/oxlint --type-aware --deny-warnings tools
	@$(BIN)/oxfmt --check $(TS_FILES)

lint-shell:
	$(NEED_SHELL_TOOLS)
	@shellcheck $(SHELL_SCRIPTS)
	@shfmt -d $(SHELL_SCRIPTS)

fmt:
	$(NEED_NPM)
	$(NEED_SHELL_TOOLS)
	@$(BIN)/oxfmt $(TS_FILES)
	@shfmt -w $(SHELL_SCRIPTS)

fmt-check:
	$(NEED_NPM)
	$(NEED_SHELL_TOOLS)
	@$(BIN)/oxfmt --check $(TS_FILES)
	@shfmt -d $(SHELL_SCRIPTS)

# Not part of make lint: actionlint is not packaged for every platform. CI runs it separately.
lint-workflows:
	@command -v actionlint >/dev/null || { echo 'Install actionlint (brew install actionlint, or go install github.com/rhysd/actionlint/cmd/actionlint@latest).' >&2; exit 1; }
	@actionlint

# Former name for the shell checks.
check: lint-shell

ci: lint test

test-git-ai:
	@cd tools/git-ai && node --test test/*.test.ts

test-git-tidy:
	@cd tools/git-tidy && node --test test/*.test.ts

test-git-wt:
	@cd tools/git-wt && node --test test/*.test.ts

test-git-live:
	@cd tools/git-live && node --test test/*.test.ts

test-qq:
	@cd tools/qq && node --test test/*.test.ts

test: test-shared test-git-ai test-git-tidy test-git-wt test-git-live test-qq

test-shared:
	@cd tools/shared && node --test test/*.test.ts
