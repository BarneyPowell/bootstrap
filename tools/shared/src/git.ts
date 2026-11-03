import { run } from './process.ts';
import type { RunOptions, Result } from './process.ts';
import { Failure } from './errors.ts';

// Git in one repository, without a pager or colour, sharing the caller's cancellation signal.
export class Repo {
  cwd: string;
  signal?: AbortSignal;
  constructor(cwd = process.cwd(), signal?: AbortSignal) {
    this.cwd = cwd;
    this.signal = signal;
  }
  async capture(args: string[], options: RunOptions = {}): Promise<Result> {
    return await run('git', ['--no-pager', '-c', 'color.ui=false', ...args], {
      cwd: this.cwd,
      signal: this.signal,
      ...options,
    });
  }
  async text(args: string[], action: string): Promise<string> {
    const result = await this.capture(args);
    if (result.code !== 0) throw new Failure('git-error', `Git ${args[0]} failed while ${action}.`);
    return result.stdout.replace(/\n$/, '');
  }
}
