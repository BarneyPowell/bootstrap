# shared

Helpers that more than one tool in `tools/` uses. A tool imports them with a
relative path, for example `../../shared/src/process.ts`. Tools never import
from each other. When a helper is needed in a second tool, move it here.

| Module | Contents |
| ------ | -------- |
| `src/process.ts` | `run()`: spawn without a shell, with deadlines, cancellation, output limits and terminal modes. `requireCommand()`: check `<cmd> --version` and fail with install guidance. |
| `src/errors.ts` | `Failure` and its shared kinds. A tool adds its own kinds by passing them, for example `new Failure('auth-required', …)`. Also `diagnostic()` (strips control characters) and `cancelled()`. |
| `src/gum.ts` | `requireGum()`, `gumText()` and `styleText()`. Also the shared colour palette, `paint()`, and `table()` with its width helpers. |
| `test/git-env.ts` | Import it first in every test file. It keeps tests away from the real Git config and repository environment. |
| `test/pty_driver.py` | Gives a command under test a real terminal. |

Run the tests with `make test-shared`. The tool suites test these helpers
indirectly as well.
