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
changed during installation. The model picker below writes only its explicitly
selected model setting.

## Usage

```sh
git ai --help
git ai --version
git ai doctor
git ai ollama models
git ai ollama models --local
git ai codex models
git ai codex models --local
git ai commit
git ai commit --dry-run
git ai commit --provider apple
git ai commit --provider ollama --model '<installed-local-model-id>'
git ai commit --provider codex --model '<supported-lightweight-model-id>' --reasoning-effort low
git ai commit --provider claude --model '<supported-lightweight-model-id>'
```

Angle-bracketed identifiers are **placeholders**, not model names to copy.
Provider pinning disables fallback. Model/effort overrides require a provider.
Claude currently reports the unavailable state below. Codex uses the constrained
CLI integration described below. No CLI default model is inherited or guessed.

An ordinary commit needs a terminal before generation begins. Dry-run needs no
terminal, prints only the message to stdout, and never runs an editor or commit.
All tool status/doctor output goes to stderr. Dry-run is **not** an offline mode.
Arbitrary commit flags and pathspecs are rejected, including `-a`, message flags,
`--amend`, `--no-edit`, and `--no-verify`. Nothing is staged automatically.

### Choose an Ollama default

Run `git ai ollama models` in a terminal to choose from the service's installed
models using **gum**. It checks for gum and the Ollama CLI and queries the
configured `ai.ollama.endpoint` using the documented
[`GET /api/tags` endpoint](https://docs.ollama.com/api/tags). It does not start
Ollama, pull models, or run inference.

The saved global default appears first, marked **current default**. Enter keeps
it; choose another row to replace it. A missing default is shown in the header,
and a default no longer on the service is explicitly labelled unavailable.
Esc/Ctrl+C cancels without saving. An empty list or unavailable service leaves
settings unchanged. gum and Ollama must already be installed (`make ensure-gum`
offers to install gum separately).

The command writes **only `ai.ollama.model` globally**, leaving `ai.providers`
and the fallback order unchanged. `--global` is explicit shorthand for the
default; `--local` instead writes the repository's local setting. Global selection
also works outside a repository. Existing repository/worktree/include overrides
remain effective, and the command reports when one overrides the saved default.
Remote endpoints respect `ai.allowCloud`; listed remote models are marked, and
selecting one does not grant cloud authorisation. No repository content is sent
to list models.

### Choose a Codex default

`git ai codex models` uses the same gum picker to save **`ai.codex.model`
globally**; `--local` saves a repository override instead. This is the existing
configuration key (not `ai.models.codex`). It leaves `ai.providers`, cloud policy,
context fallback policy, and reasoning effort unchanged. The saved default is
first and marked; cancellation saves nothing. A repository override is reported
if it remains effective after saving a global default.

Models come from the installed CLI's documented
[`codex debug models` JSON catalog](https://learn.chatgpt.com/docs/developer-commands#codex-debug-models),
filtered to visible entries. No model identifiers are hard-coded, and private
instruction templates from the raw catalog are neither displayed nor printed.
When `ai.allowCloud=false`, `--bundled` reads the shipped catalog offline. With
cloud enabled, the CLI may refresh it using existing authentication. This does
not run inference, send repository contents, or start a server. Catalog entries
can be bundled/cached; they are **not proof of account entitlement**.

Choosing a model does not authorise remote generation. You still need
`ai.allowCloud=true` to use it for commit messages. If the selected model's
catalog metadata does not list the currently configured reasoning effort, the
picker reports that mismatch and leaves the effort setting for you to review.
Missing/older CLIs, invalid catalogs, timeouts, empty lists, and cancellation do
not change the setting.

### Context too large: offer Codex

`ai.commit.contextFallback` controls what happens when Apple/Ollama cannot fit the
staged context:

- **`ask` (default):** use gum to offer Codex, with **Stop here** selected by
  default. Accepting authorises that fallback attempt; declining or cancelling
  stops the operation. The prompt names the model and the staged information
  being sent. It does not change any configuration.
- **`auto`:** print that local context is too small, then try Codex without a
  prompt. This also works for non-interactive dry-runs.
- **`never`:** do not use Codex in response to a context-size failure.

Configured providers continue in their normal order. Another local provider can
succeed before escalation is needed. Codex can be added once after the configured
chain, even when `ai.providers=apple`; it is not retried if already attempted.
Other failure types alone do not add it. An explicit `--provider apple` stays
pinned and does not escalate. Explicit `--provider codex` uses Codex directly.

**`ai.allowCloud=true` and an explicit `ai.codex.model` remain required in every
mode.** A repository's effective `ai.allowCloud=false` blocks cloud use before
any prompt or request; the fallback setting never overrides it. To set this up
yourself, substitute a real model identifier available to your Codex login:

```sh
git config --global ai.codex.model '<supported-lightweight-model-id>'
git config --global ai.allowCloud true
git config --global ai.commit.contextFallback ask
# Or automatically escalate when context is too large:
git config --global ai.commit.contextFallback auto
```

Use `git ai codex models` instead of entering `ai.codex.model` manually if you
prefer to pick from the CLI's catalog.

If `ask` needs a terminal or gum is missing, it fails with setup guidance and
sends nothing to Codex. Time spent answering does not consume the provider's
deadline. Dry-run still prints only the message on stdout; the prompt and switch
notice go to the terminal/stderr. No real cloud requests are made by tests.

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
| `ai.commit.contextFallback` | `ask`; `ask`, `auto`, or `never`; Codex escalation after context-size failure |
| `ai.apple.model` | `system`; fm's explicitly selected on-device model; no other identifier |
| `ai.ollama.model` | No default; exact identifier from your service's installed-model list |
| `ai.ollama.endpoint` | `http://127.0.0.1:11434`; HTTP(S) origin, no credentials/path/query/fragment |
| `ai.codex.model` | No default; explicit identifier supported by your ChatGPT Codex CLI login |
| `ai.codex.reasoningEffort` | Unset; `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; must also be supported by the chosen model |
| `ai.claude.model` | No default; explicit identifier; adapter currently unavailable |
| `ai.claude.reasoningEffort` | Unset; CLI vocabulary `low`, `medium`, `high`, `xhigh`, `max`; adapter unavailable |

Codex receives the configured reasoning effort explicitly; a rejected setting
fails rather than being silently discarded. Claude effort settings remain
unavailable with that adapter. Model entitlement is not inferred from CLI help.
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
| Codex | `codex exec -` with explicit model/effort, private temporary cwd, read-only sandbox, `approval_policy=never`, ignored user config, ephemeral sessions, fixed instructions, disabled command/hook/app/plugin/multi-agent/memory features, empty MCP config and disabled web search. Final text is read from `--output-last-message`; protocol logs remain private. Uses existing ChatGPT authentication and refuses paid API credential substitution. |
| Claude | **Unavailable**. Inspected Claude Code `2.1.308` `--help`: `-p`, `--tools ""`, `--strict-mcp-config`, and `--safe-mode` exist, but official documentation says managed hooks still apply. This v1 cannot guarantee their exclusion and refuses generation. |

CLI probes run in private temporary directories without repository data. Codex
checks `exec --help` and `features list` for required controls before generation;
older/incompatible CLIs remain unavailable. Inspected installed version: 0.166.0.
Claude only probes its version and remains unavailable. Authentication and model
entitlement cannot be established from these probes alone; generation errors
provide setup guidance without printing raw provider logs.

The Codex path implements the subsequently agreed practical CLI constraints,
relaxing the original spec's requirement for an absolute text-only guarantee.
It does **not** sandbox the entire Codex process or prove that every future tool,
user skill, system configuration or managed-policy interaction is excluded. Its
read-only sandbox is not a filesystem-read isolation boundary. The CLI and its
managed policies must be trusted. We do not pass the repository as cwd or grant
it through `--add-dir`, inherit Git path variables, or send unstaged/untracked
contents. Optional available browser/image/skill features are disabled too. If
the protocol reports a command/file/MCP/web action, the result is refused;
detecting an event cannot undo an action that already occurred. Passive reasoning
and plan items are allowed. Codex can also emit non-fatal `error` items (including
CLI feature warnings) during a successful run. These are not tool actions and
do not discard a valid final message when the process exits zero and reports
`turn.completed`. Top-level errors, failed/incomplete turns, and actual action
items still fail; unknown item types are named without exposing their content.
There is no bypass-sandbox,
approval bypass, rule bypass, session resumption, or automatic login flag.

Interface references checked on 2026-11-01:
[Apple fm CLI introduction](https://developer.apple.com/videos/play/wwdc2026/334/),
[Apple generation/context guidance](https://developer.apple.com/documentation/FoundationModels/generating-content-and-performing-tasks-with-foundation-models),
[Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md),
[Codex non-interactive interface](https://learn.chatgpt.com/docs/non-interactive-mode),
[Codex configuration controls](https://learn.chatgpt.com/docs/config-file/config-reference),
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
in, a remote provider receives the prepared staged data and instructions. The
`ask` context-fallback policy adds its requested per-escalation confirmation;
ordinary configured remote-provider use does not prompt again. Loopback IPs/localhost classify an Ollama endpoint
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
Codex uses a 64 KiB prepared-input safety cap, **not** a claim about the configured
model's exact context window. The CLI adds its own framing; actual context
rejection is reported. The same inventory/excerpt rules apply at this larger cap.

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
signing, or modification of your real Git config. Picker tests write temporary
global/local config files and cover current/missing defaults, cancellation,
dependencies, service failures, overrides, and literal model identifiers.
Codex picker tests use a fake CLI catalog to verify visible-model filtering,
offline/refreshed listing arguments, scope, unchanged policies and effort, error
redaction, deadlines and cleanup. The Ollama/Codex pickers share the same UI and
Git-setting code.
Context fallback tests exercise gum accept/decline/cancel, unattended automatic
mode, privacy/pinning/never policies, Codex arguments and stdin, repair limits,
auth/context/effort errors, tool-event refusal, deadlines and temporary cleanup
with a deterministic fake Codex executable. They do not prove vendor behaviour.
Regression tests also cover planning metadata, non-fatal error items followed
by successful completion, incomplete turns with populated message files, and
type-only action diagnostics.
`make check` runs ShellCheck.

Actually exercised on this Mac: Node 26.12.1, Git 2.56.0, macOS 27.2 arm64;
`/usr/bin/fm` help, config-default checks and model availability listing
(`system` available as AFM 3 Core Advanced outside the sandbox). gum 2.0.2's
real `choose` UI was exercised in a PTY, confirming Enter selects the first
current-default row and the selected value is captured separately from the UI.
The installed Codex 0.166.0 `debug models --bundled` interface and catalog metadata
were inspected offline; catalog listing did not verify account entitlement and
no live catalog refresh was tested.
Ollama client 0.40.11 was present, with no
running service during inspection. A deliberate synthetic `gpt-6.1-terra` Codex
request reproduced a successful zero-exit, completed turn with a non-fatal error
item that the original adapter incorrectly rejected. Only synthetic input
were sent; no repository changes were used. The revised parser's regression
test replays that event sequence. **Live Apple/Ollama generation remains
unverified; the real staged-repository commit flow was not rerun.** Mock tests do not verify
vendor inference quality or compatibility. Older supported versions and Linux
were not tested on this machine.

Optional, deliberately run these yourself in a repository with staged changes:

```sh
git ai doctor
git ai commit --provider apple --dry-run
# Only after you have separately installed a model and started Ollama:
ollama list
git ai commit --provider ollama --model '<exact-installed-model-id>' --dry-run
# Only after deliberately configuring the Codex model and cloud authorisation:
git ai commit --provider codex --dry-run
# To exercise the ask/auto escalation path, use a staged set too large for Apple:
git ai commit --dry-run
```

For CLI checks, `git ai doctor` reports controls/versions and policy without
inference; only the deliberate commit/dry-run commands above send prepared data.
If an endpoint or policy blocks generation, doctor and stderr describe why.
Apple may need Apple Intelligence enabled/ready, `fm` terms reviewed, or a custom
fm provider default removed by you. For index changes, inspect `git diff --cached`
and rerun. Hooks/editor/signing
failures are Git failures: recover normally; do not assume a commit was created.

The CLI dispatch table is the extension point for future subcommands. Provider,
configuration, Git, prompt, validation, fallback, and handoff concerns stay in
separate modules. `ollama models` manages the provider's default independently of
commit generation, as does `codex models`. There is no plugin framework or
additional autonomous coding workflow.
