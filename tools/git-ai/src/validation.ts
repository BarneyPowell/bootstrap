import { Failure } from './errors.ts';

export function validateMessage(output: unknown, subjectMaxLength: number): string {
  if (typeof output !== 'string' || !output.trim()) throw new Failure('invalid-output', 'Provider returned an empty message.');
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(output) || output.includes('```'))
    throw new Failure('invalid-output', 'Message contains control characters or Markdown fences.');
  const message = output.trim();
  if (Buffer.byteLength(message) > 8000) throw new Failure('invalid-output', 'Message exceeds 8000 bytes.');
  const [subject, second] = message.split('\n');
  if (!/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^()\r\n]+\))?!?: \S.*$/.test(subject))
    throw new Failure('invalid-output', 'Expected a Conventional Commits header.');
  if ([...subject].length > subjectMaxLength) throw new Failure('invalid-output', 'Subject exceeds the configured length limit.');
  if (second !== undefined && second !== '') throw new Failure('invalid-output', 'Separate the body from the subject with a blank line.');
  return message;
}
