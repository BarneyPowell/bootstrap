# shared

Helpers that more than one tool in `tools/` uses. A tool imports them with a
relative path, for example `../../shared/src/process.ts`. Tools never import
from each other. When a helper is needed in a second tool, move it here.

| Module | Contents |
| ------ | -------- |
| `src/process.ts` | `run()`: spawn without a shell, with deadlines, cancellation, output limits and terminal modes. `requireCommand()`: check `<cmd> --version` and fail with install guidance. `scratch()`: run code in a private temporary directory that is always removed. |
| `src/errors.ts` | `Failure` and its shared kinds. A tool adds its own kinds by passing them, for example `new Failure('auth-required', …)`. Also `diagnostic()` (strips control characters) and `cancelled()`. |
| `src/ai/config.ts` | `loadAiConfig()`: the provider settings `git ai` and `qq` share (`ai.providers`, `ai.allowCloud`, `ai.<provider>.model`, …). A tool can pass a scope such as `qq` so that `qq.providers` and `qq.timeoutSeconds` take precedence. `configReader()` reads Git config and records where each key came from. |
| `src/ai/providers.ts` | `createAdapter(name, config, task)` for apple, ollama, codex and claude. A `Task` gives the tool name, system instructions and output limits. A `selfContained` prompt (git-ai's) already carries its instructions. Also `httpJSON()`, `isLoopback()` and `executableVersion()`. |
| `src/ai/claude.ts`, `src/ai/codex.ts` | The constrained Claude Code and Codex CLI integrations: private working directory, no tools, verified session constraints. |
| `src/git.ts` | `Repo`: run Git in one repository without a pager or colour. `capture()` returns the result; `text()` returns stdout or fails with a `git-error`. |
| `src/gum.ts` | `requireGum()`, `gumText()`, `styleText()` and `confirm()` (yes, no or cancel). Also the shared colour palette, `paint()`, and `table()` with its width helpers. |
| `src/terminal.ts` | `colour(stream)`: true on a terminal unless `NO_COLOR` is set. `Spinner`: a stderr spinner that draws only on a terminal. |
| `test/git-env.ts` | Import it first in every test file. It keeps tests away from the real Git config and repository environment. |
| `test/pty_driver.py` | Gives a command under test a real terminal. |

Run the tests with `make test-shared`. The tool suites test these helpers
indirectly as well.
