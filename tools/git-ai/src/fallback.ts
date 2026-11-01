import type { Config, ProviderName } from './config.ts';
import type { Snapshot } from './git.ts';
import { createAdapter } from './providers.ts';
import type { Adapter } from './providers.ts';
import { Failure, cancelled, diagnostic } from './errors.ts';
import { prepare } from './prompt.ts';
import { validateMessage } from './validation.ts';

export async function generate(snapshot: Snapshot, config: Config, signal: AbortSignal,
  report: (line: string) => void,
  factory: (name: ProviderName, config: Config) => Adapter = createAdapter,
  validateCleanup: (message: string) => Promise<void> = async () => {}): Promise<string> {
  const failures: string[] = [];
  for (const name of config.providers) {
    cancelled(signal);
    const deadline = AbortSignal.timeout(config.timeoutSeconds * 1000);
    const providerSignal = AbortSignal.any([signal, deadline]);
    try {
      const adapter = factory(name, config);
      const capabilities = await adapter.probe(providerSignal);
      // Enforce policy in orchestration as well as the adapter, including mocks.
      if (capabilities.locality === 'remote' && !config.allowCloud) throw new Failure('privacy-blocked', 'Remote inference is disabled by ai.allowCloud.');
      const request = prepare(snapshot, config.subjectMaxLength, capabilities.inputBytes);
      report(`${name} model=${diagnostic(capabilities.model)} (${capabilities.locality})${request.partial ? '; partial patch evidence, complete inventory' : ''}`);
      let repair = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const output = await adapter.generate(request.prompt + repair, providerSignal);
        cancelled(providerSignal);
        try {
          const message = validateMessage(output, config.subjectMaxLength);
          await validateCleanup(message);
          return message;
        }
        catch (error) {
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
      const failure = deadline.aborted ? new Failure('timeout', 'Provider deadline exceeded.') : error instanceof Failure ? error : new Failure('transport/service-error', 'Provider failed; raw diagnostics suppressed.');
      if (failure.kind === 'configuration-invalid' || failure.kind === 'cancelled') throw failure;
      const summary = `${name}: ${failure.kind}: ${diagnostic(failure.message)}`;
      report(summary);
      failures.push(summary);
    }
  }
  throw new Failure('unavailable', `No provider produced a valid message. ${failures.join(' | ')}`);
}
