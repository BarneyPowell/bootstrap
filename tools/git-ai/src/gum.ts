import { run } from './process.ts';
import { Failure } from './errors.ts';

// Run gum for its rendered text. gum drops colour when its output is a pipe, so
// colour is forced; callers write the captured text to the terminal themselves.
export async function gumText(args: string[], signal: AbortSignal, input?: string): Promise<string> {
  const result = await run('gum', args, { signal, input, env: { ...process.env, CLICOLOR_FORCE: '1' }, timeoutMs: 5000 });
  if (result.code !== 0) throw new Failure('unavailable', 'gum rendering failed.');
  return result.stdout.replace(/\n$/, '');
}

// Text is passed after `--` as a plain argument: never a template, never a flag.
export const styleText = (signal: AbortSignal, text: string, ...flags: string[]) => gumText(['style', ...flags, '--', text], signal);
