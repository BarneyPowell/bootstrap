import type { Config, ProviderName } from './config.ts';
import type { Snapshot } from './git.ts';
import { createAdapter } from './providers.ts';
import type { Adapter } from './providers.ts';
import { Failure, cancelled, diagnostic } from '../../shared/src/errors.ts';
import { prepare } from './prompt.ts';
import { validateMessage } from './validation.ts';
import { confirmContextFallback } from './context-fallback.ts';
import type { ContextDecision } from './context-fallback.ts';

export type Proposal = { message: string; provider: ProviderName; model: string; locality: 'local' | 'remote' };

export async function generate(
  snapshot: Snapshot,
  config: Config,
  signal: AbortSignal,
  report: (line: string) => void,
  factory: (name: ProviderName, config: Config) => Adapter = createAdapter,
  validateCleanup: (message: string) => Promise<void> = async () => {},
  decide: ContextDecision = confirmContextFallback,
): Promise<string> {
  return (await generateProposal(snapshot, config, signal, report, factory, validateCleanup, decide)).message;
}

// As generate, but also says which provider produced the message.
export async function generateProposal(
  snapshot: Snapshot,
  config: Config,
  signal: AbortSignal,
  report: (line: string) => void,
  factory: (name: ProviderName, config: Config) => Adapter = createAdapter,
  validateCleanup: (message: string) => Promise<void> = async () => {},
  decide: ContextDecision = confirmContextFallback,
): Promise<Proposal> {
  const failures: string[] = [];
  const contextLimited = new Set<ProviderName>();
  const candidates = [...config.providers];
  if (!config.pinned && config.contextFallback !== 'never' && !candidates.includes('codex')) candidates.push('codex');
  for (const name of candidates) {
    cancelled(signal);
    if (name === 'codex' && !config.providers.includes('codex') && contextLimited.size === 0) continue;
    let deadline: AbortSignal | undefined;
    try {
      if (name === 'codex' && contextLimited.size > 0 && !config.pinned) {
        if (config.contextFallback === 'never') {
          report('Context fallback to Codex is disabled by ai.commit.contextFallback=never.');
          continue;
        }
        if (!config.allowCloud)
          throw new Failure(
            'privacy-blocked',
            'Context fallback to Codex requires ai.allowCloud=true; cloud policy is unchanged.',
          );
        if (!config.models.codex)
          throw new Failure(
            'model-not-configured',
            'Set ai.codex.model to an explicit model before using context fallback.',
          );
        report(
          `${[...contextLimited].join(', ')} context is too small; ${config.contextFallback === 'auto' ? 'automatically trying' : 'offering'} Codex (${diagnostic(config.models.codex)}, remote).`,
        );
        if (config.contextFallback === 'ask' && !(await decide(config, [...contextLimited], signal)))
          throw new Failure('cancelled', 'Codex fallback declined; no Codex request was sent.');
      }
      // Human decision time does not consume the provider's execution deadline.
      deadline = AbortSignal.timeout(config.timeoutSeconds * 1000);
      const providerSignal = AbortSignal.any([signal, deadline]);
      const adapter = factory(name, config);
      const capabilities = await adapter.probe(providerSignal);
      // Enforce policy in orchestration as well as the adapter, including mocks.
      if (capabilities.locality === 'remote' && !config.allowCloud)
        throw new Failure('privacy-blocked', 'Remote inference is disabled by ai.allowCloud.');
      const request = prepare(snapshot, config.subjectMaxLength, capabilities.inputBytes);
      report(
        `${name} model=${diagnostic(capabilities.model)} (${capabilities.locality})${request.partial ? '; partial patch evidence, complete inventory' : ''}`,
      );
      let repair = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const output = await adapter.generate(request.prompt + repair, providerSignal);
        cancelled(providerSignal);
        try {
          const message = validateMessage(output, config.subjectMaxLength);
          await validateCleanup(message);
          return { message, provider: name, model: capabilities.model, locality: capabilities.locality };
        } catch (error) {
          if (!(error instanceof Failure) || error.kind !== 'invalid-output' || attempt === 1) throw error;
          report(`${name}: invalid output; making one repair attempt within the same deadline.`);
          // Never echo the bad message back; it may contain hostile instructions.
          repair = `\nREPAIR: ${error.message} Return only one valid Conventional Commits message; obey the subject limit and use a blank line before any body.`;
          if (Buffer.byteLength(request.prompt + repair) > capabilities.inputBytes)
            throw new Failure('invalid-output', 'Invalid output; no room for a bounded repair request.');
        }
      }
    } catch (error) {
      cancelled(signal);
      const failure = deadline?.aborted
        ? new Failure('timeout', 'Provider deadline exceeded.')
        : error instanceof Failure
          ? error
          : new Failure('transport/service-error', 'Provider failed; raw diagnostics suppressed.');
      if (failure.kind === 'configuration-invalid' || failure.kind === 'cancelled') throw failure;
      if (failure.kind === 'context-too-large' && (name === 'apple' || name === 'ollama')) contextLimited.add(name);
      const summary = `${name}: ${failure.kind}: ${diagnostic(failure.message)}`;
      report(summary);
      failures.push(summary);
    }
  }
  throw new Failure('unavailable', `No provider produced a valid message. ${failures.join(' | ')}`);
}
