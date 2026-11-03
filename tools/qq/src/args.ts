import { Failure } from '../../shared/src/errors.ts';
import { providers } from '../../shared/src/ai/config.ts';
import type { AiOverrides, ProviderName } from '../../shared/src/ai/config.ts';

export const version = 'qq 1.0.0';

export const help = `${version} — ask an AI provider a quick question from the terminal

Usage:
  qq [options] <question…>       ask the words that follow
  qq [options]                   type the question at a prompt
  <command> | qq [options] [question…]
                                 piped text is the question, or context for it

Options (only before the question):
  --provider apple|ollama|codex|claude
                                 use only this provider (no fallback)
  --model <id>                   model for --provider
  --reasoning-effort <level>     reasoning effort for --provider (codex, claude)
  --plain                        print the answer as raw text, without gum formatting
  --                             end of options, for a question that starts with -
  -h, --help                     show this help
  --version                      show the version

Providers come from Git config: qq.providers (falling back to ai.providers),
ai.<provider>.model and ai.allowCloud, as for git ai. qq.timeoutSeconds
overrides ai.timeoutSeconds. Run git ai doctor to check provider readiness.
In zsh, ? and * in an unquoted question are globs; make install adds
alias qq='noglob qq'. Quote questions that contain an apostrophe.
`;

export type Options = AiOverrides & { plain?: boolean };
export type Parsed = { command: 'help' | 'version' | 'ask'; options: Options; question: string };

// Options are read only up to the first word of the question, so a question can
// mention flags ("qq what does git push --force do") without qq taking them.
export function parseArgs(args: string[]): Parsed {
  const options: Options = {};
  const seen = new Set<string>();
  let i = 0;
  for (; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--') {
      i++;
      break;
    }
    if (!flag.startsWith('-') || flag === '-') break;
    if (flag === '-h' || flag === '--help') return { command: 'help', options: {}, question: '' };
    if (flag === '--version') return { command: 'version', options: {}, question: '' };
    if (seen.has(flag)) throw new Failure('configuration-invalid', `Repeated option: ${flag}.`);
    seen.add(flag);
    if (flag === '--plain') {
      options.plain = true;
      continue;
    }
    if (!['--provider', '--model', '--reasoning-effort'].includes(flag))
      throw new Failure(
        'configuration-invalid',
        `Unknown option: ${flag}. Run qq --help, or put -- before a question that starts with -.`,
      );
    const value = args[++i];
    if (value === undefined || value.startsWith('-'))
      throw new Failure('configuration-invalid', `Missing value for ${flag}.`);
    if (flag === '--provider') {
      if (!providers.includes(value as ProviderName))
        throw new Failure('configuration-invalid', 'Unknown provider; choose apple, ollama, codex, or claude.');
      options.provider = value as ProviderName;
    } else if (flag === '--model') options.model = value;
    else options.reasoningEffort = value;
  }
  if ((options.model !== undefined || options.reasoningEffort !== undefined) && !options.provider)
    throw new Failure('configuration-invalid', '--model and --reasoning-effort require --provider.');
  return { command: 'ask', options, question: args.slice(i).join(' ').trim() };
}
