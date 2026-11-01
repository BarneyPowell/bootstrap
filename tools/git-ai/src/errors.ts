export type FailureKind = 'not-installed' | 'unavailable' | 'model-not-configured' |
  'auth-required' | 'configuration-invalid' | 'timeout' | 'context-too-large' |
  'transport/service-error' | 'invalid-output' | 'cancelled' | 'privacy-blocked' | 'git-error';

export class Failure extends Error {
  kind: FailureKind;
  constructor(kind: FailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export function diagnostic(value: unknown): string {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 500);
}

export function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Failure('cancelled', 'Cancelled.');
}
