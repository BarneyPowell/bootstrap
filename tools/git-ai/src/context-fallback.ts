import type { Config, ProviderName } from './config.ts';
import { run } from '../../shared/src/process.ts';
import { Failure, cancelled, diagnostic } from '../../shared/src/errors.ts';

export type ContextDecision = (config: Config, failed: ProviderName[], signal: AbortSignal) => Promise<boolean>;

export const confirmContextFallback: ContextDecision = async (config, failed, signal) => {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Failure(
      'unavailable',
      'Context fallback needs a terminal to ask. Set ai.commit.contextFallback=auto for unattended fallback, or never to keep it disabled.',
    );
  let result;
  try {
    result = await run(
      'gum',
      [
        'confirm',
        '--default=false',
        '--timeout=0s',
        '--affirmative=Use Codex',
        '--negative=Stop here',
        '--',
        `${failed.join(', ')} cannot fit these staged changes. Send the prepared staged diff, inventory and recent subjects to Codex (${diagnostic(config.models.codex)}) for this message?`,
      ],
      { signal, interactive: true, timeoutMs: 0 },
    );
  } catch (error) {
    cancelled(signal);
    if (error instanceof Failure && error.kind === 'not-installed')
      throw new Failure(
        'not-installed',
        'gum is required to ask about Codex fallback. Run make ensure-gum, or configure ai.commit.contextFallback=auto or never.',
      );
    throw error;
  }
  cancelled(signal);
  if (result.code === 130) throw new Failure('cancelled', 'Codex fallback cancelled; no request sent.');
  if (![0, 1].includes(result.code))
    throw new Failure('unavailable', 'gum confirmation failed; no Codex request sent.');
  return result.code === 0;
};
