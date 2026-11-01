# git-ai

`git ai commit` proposes one Conventional Commits message for the **staged**
changes, then opens Git's normal commit editor. Saving and exiting accepts the
prefilled message, including when you leave it unchanged. To abort, delete the
whole message and save, or exit the editor with an error. Merely closing an
editor successfully without editing accepts the proposal.

## Build and install

Requires Bash, Git (2.31+ for path resolution), and Node.js **22.18+** with native
TypeScript support (24 LTS recommended; Node 23 is rejected). There are no npm
dependencies, TypeScript runner, package installation, or JavaScript build step.
Node strips types; it does not type-check them. Linux supports the Ollama adapter.
Windows is not supported; WSL can use its Linux tools.

From the bootstrap clone:

```sh
make check
make test-git-ai
make install            # explicitly install symlinks into ~/.local/bin
git ai doctor
```

`make install` runs the existing gum prerequisite and symlink installer.
This implementation has not run `make install` on your behalf.
Keep the clone in place. If needed, open a new terminal or run
`export PATH="$HOME/.local/bin:$PATH"`.

Apple uses the built-in **`fm` command on macOS 27+**, with Apple Intelligence
enabled and ready. No Swift helper, compiler, or native build step is required.
Missing/unavailable `fm` advances to the next configured provider. Older macOS
compatibility is deferred; there is no unused compatibility flag in v1. If a
native fallback is needed later, it should be explicitly opted into.

To uninstall this command, remove **only** the `~/.local/bin/git-ai` symlink that
points at this clone. The shared PATH
setting and other custom Git commands can remain. No Git settings or hooks are
installed by the tool.

## Usage

```sh
git ai --help
git ai --version
git ai doctor
git ai commit
git ai commit --dry-run
git ai commit --provider apple
git ai commit --provider ollama --model '<installed-local-model-id>'
git ai commit --provider codex --model '<supported-lightweight-model-id>' --reasoning-effort low
git ai commit --provider claude --model '<supported-lightweight-model-id>'
```

Angle-bracketed identifiers are **placeholders**, not model names to copy.
Provider pinning disables fallback. Model/effort overrides require a provider.
Codex/Claude commands currently report the explicit limitations below; they do
not send content. No CLI default model is inherited or guessed.

An ordinary commit needs a terminal before generation begins. Dry-run needs no
terminal, prints only the message to stdout, and never runs an editor or commit.
All tool status/doctor output goes to stderr. Dry-run is **not** an offline mode.
Arbitrary commit flags and pathspecs are rejected, including `-a`, message flags,
`--amend`, `--no-edit`, and `--no-verify`. Nothing is staged automatically.

## Configuration

These are **this project's** Git configuration keys, not built-in Git/AI vendor
settings. CLI overrides beat effective Git config, which beats defaults. Reads
use `git config`, preserving native system/global/local/worktree and include
precedence. Values are validated before any provider request; Git parses booleans.

| Key | Default / accepted value |
| --- | --- |
| `ai.providers` | `apple,ollama,codex,claude`; trimmed, unique, known names |
| `ai.allowCloud` | `false`; a Git boolean |
| `ai.timeoutSeconds` | `30`; integer 1–3600, one deadline per provider |
| `ai.commit.recentCount` | `8`; integer 0–100; subjects capped at 200 characters each |
| `ai.commit.subjectMaxLength` | `72`; integer 1–1000 Unicode characters |
| `ai.apple.model` | `system`; fm's explicitly selected on-device model; no other identifier |
| `ai.ollama.model` | No default; exact identifier from your service's installed-model list |
| `ai.ollama.endpoint` | `http://127.0.0.1:11434`; HTTP(S) origin, no credentials/path/query/fragment |
| `ai.codex.model` | No default; explicit identifier; adapter currently unavailable |
| `ai.codex.reasoningEffort` | Unset; `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; adapter unavailable |
| `ai.claude.model` | No default; explicit identifier; adapter currently unavailable |
| `ai.claude.reasoningEffort` | Unset; CLI vocabulary `low`, `medium`, `high`, `xhigh`, `max`; adapter unavailable |

Model support for reasoning effort cannot be verified without a supported CLI
integration; these settings never cause a request or get silently discarded.
Apple/Ollama reasoning settings are rejected. Auto mode skips unconfigured
providers with reasons; pinning an unconfigured provider is a configuration error.

Example commands for **you** to run, substituting real installed/supported IDs:

```sh
git config --global ai.providers 'apple,ollama,codex,claude'
git config --global ai.ollama.model '<installed-local-model-id>'
git config --global ai.codex.model '<supported-lightweight-model-id>'
git config --global ai.claude.model '<supported-lightweight-model-id>'
# Optional authorisation for remote inference; not run by the implementation:
git config --global ai.allowCloud true
# Override globally permitted cloud use in a particular repository:
git config --local ai.allowCloud false
```

The helper does not read/extract credentials, use subscription tokens directly,
or switch to paid APIs. No credential belongs in these settings. Doctor reports
origins for configured keys, effective policy, model/effort settings, executable
versions, and lightweight availability without sending repository contents.

## Providers and verified interfaces

| Provider | v1 integration |
| --- | --- |
| Apple | Built-in `fm`: availability via `models`, token counting via `count-tokens --quiet`, generation via `respond --model system --use-case general --guardrails default --no-stream --greedy`. Prompt is sent on stdin; no tools, transcript, session resumption, server, or cloud model. |
| Ollama | Documented HTTP `/api/tags`, `/api/show`, `/api/generate`; exact installed model, reported context size, raw text generation, no tools, downloads, or service startup. |
| Codex | **Unavailable**. Inspected `codex-cli 0.166.0` `exec --help` and official documentation: `exec`, read-only sandbox, ephemeral output, isolated cwd and final-message capture do not establish a complete no-tools/no-integrations contract. No agent is launched. |
| Claude | **Unavailable**. Inspected Claude Code `2.1.308` `--help`: `-p`, `--tools ""`, `--strict-mcp-config`, and `--safe-mode` exist, but official documentation says managed hooks still apply. This v1 cannot guarantee their exclusion and refuses generation. |

CLI version-only probes run in private temporary directories with no prompt,
not in the working repository. Authentication and model entitlement for those
CLIs remain **unverified**; an installed executable does not establish them.
Enabling cloud policy does not enable an unsafe CLI integration. These are
intentional unavailable states, not working remote adapters. A future adapter
needs a verified text-only interface that meets the same isolation contract.

Interface references checked on 2026-11-01:
[Apple fm CLI introduction](https://developer.apple.com/videos/play/wwdc2026/334/),
[Apple generation/context guidance](https://developer.apple.com/documentation/FoundationModels/generating-content-and-performing-tasks-with-foundation-models),
[Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md),
[Codex non-interactive interface](https://learn.chatgpt.com/docs/non-interactive-mode),
[Claude CLI](https://code.claude.com/docs/en/cli-reference), and
[Claude hook policy](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks).
The installed `/usr/share/man/man1/fm.1` (dated June 8, 2026), subcommand help,
and actual model-list output were checked. `fm` has no `--version` option; its
interface is recorded with the macOS version instead. `fm models` can exit 1
because PCC is unavailable while marking `system` available; the adapter checks
the explicit system availability line. An unrecognised output format fails
closed and allows fallback. If machine-wide CLI terms have not been accepted,
review `fm license --status` and Apple's instructions yourself; git-ai never
accepts terms or runs privileged commands. Custom fm provider defaults are
refused before content is sent. `fm` ignores HOME overrides for its config
location, so pretending a temporary HOME isolates those defaults would be wrong.

## Data, context, and safety boundaries

Only indexed differences, a complete inventory (status, paths, modes, object IDs,
file kind), and bounded recent subjects reach the selected model. Unstaged and
untracked contents and arbitrary repository documents are excluded. Binary
content is not sent; Git's binary marker is used. Symlinks are diffed as indexed
links, not followed; submodule pointers are described without recursion. External
diff, textconv, fsmonitor commands, colour and paging are disabled for context.
No LFS retrieval is requested. Git can fail on unavailable partial-clone objects.
Active merge/rebase/cherry-pick/revert operations and conflicts are rejected.

Cloud is blocked by default, even with explicit provider selection. Once opted
in, a remote provider receives the same prepared staged data and instructions
without repeated confirmation. Loopback IPs/localhost classify an Ollama endpoint
as local; known Ollama remote-model metadata overrides that classification.
Loopback cannot certify what a proxy/server does internally. HTTP redirects are
refused. There is no tool telemetry, prompt archive, persistent inference cache,
or raw provider-log output. Vendor/OS implementations have their own behaviour.

Patches are captured up to 32 KiB per file (metadata capture limit 2 MB). Context
packing conservatively budgets **one UTF-8 byte per estimated token**, not an
exact tokenizer count, and reserves 1024 tokens for output/template overhead.
Apple conservatively budgets the documented 4096-token baseline and uses `fm`
to count actual input tokens before inference; this CLI does not expose the
current context size or a maximum output-token flag. Output is bounded by the
deadline, capture limit, and message validation instead. Ollama uses reported
context capped at 8192 tokens, explicitly sets `num_ctx`, and requests at most
512 output tokens. Optional history is dropped before patch content; oversized
patches receive per-file excerpts, with compact lockfile/generated evidence.
The complete inventory and omission labels remain. Inventory that cannot fit
causes context failure/fallback; no multi-call summarisation is attempted.

Messages must have a supported Conventional Commits header and stay within the
configured subject limit and 8000-byte total limit. Controls, fences, preambles,
and malformed body separation are rejected. Git's own `stripspace` verifies that
effective comment cleanup would preserve the proposal. One repair request is
allowed within the same deadline, without echoing hostile invalid output back.
Captured subprocesses have process-group cancellation; HTTP supports abort.

The staged tree is checked before/after collection, after generation, and just
before `git commit --file <private-file> --edit --cleanup=strip`. No index lock is
held across inference or editing. **This is not an atomic snapshot guarantee**:
another process can still change the index after the final check, and normal Git
hooks can change staged/working content. Once Git starts, its normal editor,
hooks, signing, author identity, and recovery apply; its exit status is returned
without regenerating or retrying the commit. Recovery points to `COMMIT_EDITMSG`
when Git retains it. Private temporary resources are removed on normal success,
errors and handled cancellation; forced kills/crashes can leave them behind.
Deletion is not secure SSD erasure.

## Tests and optional real-provider smoke checks

`make test-git-ai` uses Node's test runner, temporary real Git repositories,
isolated Git config/identities, fake editors/hooks, fake executables, and a
loopback fake Ollama server. It needs Python 3 for its PTY driver and permission
to bind loopback. It performs **no live inference**, login, model download,
signing, or modification of your real Git config. `make check` runs ShellCheck.

Actually exercised on this Mac: Node 26.12.1, Git 2.56.0, macOS 27.2 arm64;
`/usr/bin/fm` help, config-default checks and model availability listing
(`system` available as AFM 3 Core Advanced outside the sandbox). Ollama client
0.40.11 was present, with no
running service during inspection. **Live Apple/Ollama generation and CLI
authentication/model access were not exercised.** Mock tests do not verify
vendor inference quality or compatibility. Older supported versions and Linux
were not tested on this machine.

Optional, deliberately run these yourself in a repository with staged changes:

```sh
git ai doctor
git ai commit --provider apple --dry-run
# Only after you have separately installed a model and started Ollama:
ollama list
git ai commit --provider ollama --model '<exact-installed-model-id>' --dry-run
```

For CLI checks, `git ai doctor` reports installed versions and the unavailable
integration reason; no live CLI smoke call is offered until isolation is safe.
If an endpoint or policy blocks generation, doctor and stderr describe why.
Apple may need Apple Intelligence enabled/ready, `fm` terms reviewed, or a custom
fm provider default removed by you. For index changes, inspect `git diff --cached`
and rerun. Hooks/editor/signing
failures are Git failures: recover normally; do not assume a commit was created.

The CLI dispatch table is the extension point for future subcommands. Provider,
configuration, Git, prompt, validation, fallback, and handoff concerns stay in
separate modules. There is no plugin framework or autonomous agent behaviour.
