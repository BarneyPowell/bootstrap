import { Failure, cancelled, diagnostic } from '../../shared/src/errors.ts';
import { createAdapter } from '../../shared/src/ai/providers.ts';
import type { Adapter, Task } from '../../shared/src/ai/providers.ts';
import type { AiConfig, ProviderName } from '../../shared/src/ai/config.ts';

export type Answer = { text: string; provider: ProviderName; model: string; locality: 'local' | 'remote' };
export type Factory = (name: ProviderName, config: AiConfig, task: Task) => Adapter;

// Every provider was tried; `failures` says why each one did not answer.
export class NoAnswer extends Failure<'no-answer'> {
  failures: string[];
  constructor(failures: string[]) {
    super('no-answer', 'No provider answered.');
    this.failures = failures;
  }
}

// Try each configured provider in order and return the first non-empty answer.
// Only a configuration error or cancellation stops the search early.
export async function ask(prompt: string, config: AiConfig, task: Task, signal: AbortSignal,
  onAttempt: (name: ProviderName) => void = () => {}, factory: Factory = createAdapter): Promise<Answer> {
  const failures: string[] = [];
  for (const name of config.providers) {
    cancelled(signal);
    const deadline = AbortSignal.timeout(config.timeoutSeconds * 1000);
    const providerSignal = AbortSignal.any([signal, deadline]);
    try {
      onAttempt(name);
      const adapter = factory(name, config, task);
      const capabilities = await adapter.probe(providerSignal);
      // Enforce policy here as well as in the adapter, including mocks.
      if (capabilities.locality === 'remote' && !config.allowCloud)
        throw new Failure('privacy-blocked', 'Remote inference is disabled by ai.allowCloud.');
      if (Buffer.byteLength(prompt) > capabilities.inputBytes)
        throw new Failure('context-too-large', `The question and piped input exceed this provider's ${capabilities.inputBytes}-byte budget.`);
      const text = (await adapter.generate(prompt, providerSignal)).trim();
      cancelled(providerSignal);
      if (!text) throw new Failure('invalid-output', 'The provider returned an empty answer.');
      return { text, provider: name, model: capabilities.model, locality: capabilities.locality };
    } catch (error) {
      cancelled(signal);
      const failure = deadline.aborted
        ? new Failure('timeout', `No answer within ${config.timeoutSeconds}s; raise qq.timeoutSeconds to wait longer.`)
        : error instanceof Failure ? error : new Failure('transport/service-error', 'Provider failed; raw diagnostics suppressed.');
      if (failure.kind === 'configuration-invalid' || failure.kind === 'cancelled') throw failure;
      failures.push(`${name}: ${failure.kind}: ${diagnostic(failure.message)}`);
    }
  }
  throw new NoAnswer(failures);
}
