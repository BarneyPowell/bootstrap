import { Failure } from './errors.ts';
import { providers } from './config.ts';
import type { Overrides, ProviderName } from './config.ts';

export const help = `git-ai 1.0.0 — staged Conventional Commits assistance

Usage:
  git ai commit [--dry-run] [--provider apple|ollama|codex|claude]
                [--model <id>] [--reasoning-effort <level>]
  git ai doctor
  git ai --help
  git ai --version

--model and --reasoning-effort require --provider. Provider pinning disables
fallback. No Git commit flags or pathspecs are accepted. Cloud inference is
disabled unless effective Git config ai.allowCloud is true.
`;

export function parseArgs(args: string[]): { command: 'help' | 'version' | 'doctor' | 'commit'; options: Overrides } {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) return { command: 'help', options: {} };
  if (args.length === 1 && args[0] === '--version') return { command: 'version', options: {} };
  if (args.length === 1 && args[0] === 'doctor') return { command: 'doctor', options: {} };
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
