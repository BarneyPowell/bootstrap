# qq

`qq` (quick question) sends one question to an AI provider and prints the answer
in your terminal.

```sh
qq How do I see all the members of a group in linux?
```

While qq waits it shows a spinner. On a terminal it renders the answer's
Markdown with `gum format` and then shows, dimmed, which provider and model
answered. When the output is piped, qq prints only the raw answer, so
`qq … | pbcopy` copies just the text.

## Ways to ask

| Command | Question sent |
| ------- | ------------- |
| `qq <question…>` | The words that follow, joined by spaces. |
| `qq` | Opens a `gum input` prompt (or a plain `?` prompt without gum). Esc or Ctrl+C cancels. |
| `<command> \| qq` | The piped text. |
| `<command> \| qq <question…>` | The words. The piped text is sent as context, for example `make 2>&1 \| qq why did this fail`. Only the last 32 KiB is sent. |

Options go **before** the question. Anything after the first word belongs to the
question, so `qq what does git push --force do` works as written. Use `--` before a
question that starts with `-`.

```text
--provider apple|ollama|codex|claude   use only this provider (no fallback)
--model <id>                           model for --provider
--reasoning-effort <level>             reasoning effort for --provider (codex, claude)
--plain                                raw answer, without gum formatting
-h, --help / --version
```

### zsh and special characters

In zsh, an unquoted `?` or `*` is a filename pattern. If nothing matches, zsh
stops with `no matches found` before qq runs. `make install` therefore adds this
alias to `~/.zshrc`:

```sh
alias qq='noglob qq'
```

The alias does not help with an apostrophe (`what's`) or a `!`: quote the
question, or run `qq` on its own and type it at the prompt.

## Setup

qq uses the same providers and Git settings as [`git ai`](../git-ai/README.md),
through the shared code in [`tools/shared/src/ai`](../shared/src/ai). Set them
once, globally:

```sh
git config --global ai.allowCloud true              # needed for codex and claude
git ai claude models                                # pick ai.claude.model (or set it by hand)
git config --global qq.providers claude             # optional: qq's own order
```

| Setting | Default | Meaning |
| ------- | ------- | ------- |
| `qq.providers` | `ai.providers` | Providers to try, in order. The first one that answers wins. |
| `qq.timeoutSeconds` | `ai.timeoutSeconds` (30) | How long each provider gets. |
| `ai.allowCloud` | `false` | Must be `true` for codex, claude, or a remote Ollama. |
| `ai.<provider>.model` | none | Model for each provider. Required, except for apple. |
| `ai.<provider>.reasoningEffort` | none | Optional, for codex and claude. |

`qq.providers` lets qq use a different order from commit messages, for example
a local model for commits but Claude for questions. If no provider answers, qq
lists the reason for each one. `git ai doctor` checks each provider in more detail.

A fast model is a good choice for quick questions. The `claude` and `codex` CLIs
take a few seconds to start; a local Ollama model is usually quicker.

## What is sent

- Only the question, plus any piped text, is sent. qq sends no files, no
  repository content and no shell history.
- The system prompt names your OS and shell (from `/etc/os-release` or `sw_vers`,
  and `$SHELL`) so that commands fit your machine. It asks for a short answer.
- Piped text is marked as untrusted data, and the model is told not to follow
  instructions inside it.
- Providers run with the same constraints as for `git ai`: a private temporary
  directory, no tools, no MCP servers, no session saved, and no API-key
  substitution. qq never runs a command from an answer.

## Tests

```sh
make test-qq
```

The tests use fake `claude` and `gum` executables and a private Git config. They
never contact a real provider.
