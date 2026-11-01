import { spawn } from 'node:child_process';
import { Failure, cancelled } from './errors.ts';

export type RunOptions = {
  cwd?: string; env?: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal;
  timeoutMs?: number; limit?: number; excerpt?: boolean; inherit?: boolean;
};
export type Result = { code: number; stdout: string; stderr: string; truncated: boolean };

// Each captured child owns a process group: deadlines/cancellation kill descendants too.
export async function run(executable: string, args: string[], options: RunOptions = {}): Promise<Result> {
  cancelled(options.signal);
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd, env: options.env, shell: false,
      detached: !options.inherit && process.platform !== 'win32',
      stdio: options.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    });
    let failure: Failure | undefined;
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), truncated = false;
    const stop = () => {
      try { process.kill(options.inherit || process.platform === 'win32' ? child.pid! : -child.pid!, 'SIGKILL'); } catch { /* already exited */ }
    };
    const abort = () => { failure = new Failure('cancelled', 'Cancelled.'); stop(); };
    const timer = setTimeout(() => {
      failure = new Failure('timeout', 'Process deadline exceeded.'); stop();
    }, options.timeoutMs ?? 30_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const finish = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(); reject(new Failure(error.code === 'ENOENT' ? 'not-installed' : 'unavailable', `Cannot start ${executable.split('/').at(-1)}.`));
    });
    child.stdout?.on('data', (data: Buffer) => {
      const limit = options.limit ?? 2_000_000;
      const remaining = limit - stdout.length;
      if (data.length > remaining) {
        stdout = Buffer.concat([stdout, data.subarray(0, remaining)]);
        truncated = true;
        if (!options.excerpt) failure = new Failure('context-too-large', 'Captured output exceeds the safety limit.');
        stop();
      } else stdout = Buffer.concat([stdout, data]);
    });
    // Provider stderr may contain prompts or credentials; callers never surface it.
    child.stderr?.on('data', (data: Buffer) => { stderr = Buffer.concat([stderr, data]).subarray(0, 16_384); });
    child.stdin?.on('error', () => { /* child may reject stdin and exit early */ });
    child.stdin?.end(options.input ?? '');
    child.on('close', (code, signal) => {
      finish();
      if (failure) reject(failure);
      else resolve({ code: code ?? (signal === 'SIGINT' ? 130 : 1), stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), truncated });
    });
  });
}
