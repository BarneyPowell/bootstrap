// Kinds raised by the shared helpers. Each tool adds its own: new Failure('auth-required', …)
// infers the extra kind, and every Failure is still one class for instanceof checks.
export type SharedFailureKind = 'not-installed' | 'unavailable' | 'configuration-invalid' | 'timeout' |
  'context-too-large' | 'invalid-output' | 'cancelled' | 'git-error';

export class Failure<Kind extends string = never> extends Error {
  kind: Kind | SharedFailureKind;
  constructor(kind: Kind | SharedFailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export function diagnostic(value: unknown): string {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, ' ').slice(0, 500);
}

export function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Failure('cancelled', 'Cancelled.');
}
