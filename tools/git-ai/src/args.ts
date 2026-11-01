import { Failure } from './errors.ts';
import { providers } from './config.ts';
import type { Overrides, ProviderName } from './config.ts';

export const help = `git-ai 1.0.0 — staged Conventional Commits assistance

Usage:
  git ai commit [--dry-run] [--provider apple|ollama|codex|claude]
                [--model <id>] [--reasoning-effort <level>]
  git ai doctor [--plain]
  git ai ollama models [--global|--local]
  git ai codex models [--global|--local]
  git ai claude models [--global|--local]
  git ai --help
  git ai --version

--model and --reasoning-effort require --provider. Provider pinning disables
fallback. No Git commit flags or pathspecs are accepted. Cloud inference is
disabled unless effective Git config ai.allowCloud is true.
ollama models uses gum to save only ai.ollama.model (global by default).
codex models uses gum to save only ai.codex.model (global by default).
claude models uses gum to save only ai.claude.model (global by default).
doctor draws a styled report with gum on a terminal; --plain (or NO_COLOR, or output
that is not a terminal) prints one line per fact.
Oversized context can escalate to Codex: ai.commit.contextFallback=ask|auto|never
(default ask). Requires ai.allowCloud=true and an explicit ai.codex.model.
`;

export function parseArgs(args: string[]): { command: 'help' | 'version' | 'doctor' | 'commit' | 'ollama-models' | 'codex-models' | 'claude-models'; options: Overrides; scope?: 'global' | 'local' } {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) return { command: 'help', options: {} };
  if (args.length === 1 && args[0] === '--version') return { command: 'version', options: {} };
  if (args[0] === 'doctor') {
    if (args.length === 1) return { command: 'doctor', options: {} };
    if (args.length === 2 && args[1] === '--plain') return { command: 'doctor', options: { plain: true } };
    throw new Failure('configuration-invalid', 'Usage: git ai doctor [--plain].');
  }
  if (['ollama', 'codex', 'claude'].includes(args[0]) && args[1] === 'models') {
    if (args.length > 3 || (args[2] !== undefined && !['--global', '--local'].includes(args[2])))
      throw new Failure('configuration-invalid', `Usage: git ai ${args[0]} models [--global|--local].`);
    const command = ({ codex: 'codex-models', ollama: 'ollama-models', claude: 'claude-models' } as const)[args[0] as 'codex' | 'ollama' | 'claude'];
    return { command, options: {}, scope: args[2] === '--local' ? 'local' : 'global' };
  }
  if (args[0] !== 'commit') throw new Failure('configuration-invalid', 'Unknown subcommand. Run git ai --help.');
  const options: Overrides = {};
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Failure('configuration-invalid', `Repeated option: ${flag}.`);
    seen.add(flag);
    if (flag === '--dry-run') { options.dryRun = true; continue; }
    if (!['--provider', '--model', '--reasoning-effort'].includes(flag)) throw new Failure('configuration-invalid', `Unsupported option or pathspec: ${flag}. Run git ai --help.`);
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new Failure('configuration-invalid', `Missing value for ${flag}.`);
    if (flag === '--provider') {
      if (!providers.includes(value as ProviderName)) throw new Failure('configuration-invalid', 'Unknown provider; choose apple, ollama, codex, or claude.');
      options.provider = value as ProviderName;
    } else if (flag === '--model') options.model = value;
    else options.reasoningEffort = value;
  }
  if ((options.model !== undefined || options.reasoningEffort !== undefined) && !options.provider)
    throw new Failure('configuration-invalid', '--model and --reasoning-effort require --provider.');
  return { command: 'commit', options };
}
