import { createInterface } from 'node:readline/promises';
import { Failure, cancelled } from '../../shared/src/errors.ts';
import { run } from '../../shared/src/process.ts';
import { gumText, paint, palette, requireGum } from '../../shared/src/gum.ts';
import { colour } from '../../shared/src/terminal.ts';

// Ask for the question at a prompt: gum input when available, else a plain readline prompt.
export async function readQuestion(signal: AbortSignal): Promise<string> {
  let gum = true;
  try {
    await requireGum(signal);
  } catch {
    cancelled(signal);
    gum = false;
  }
  if (gum) {
    const result = await run(
      'gum',
      [
        'input',
        '--placeholder=Ask a quick question…',
        '--prompt=? ',
        '--char-limit=0',
        `--prompt.foreground=${palette.accent}`,
        '--width=0',
      ],
      { signal, interactive: true, timeoutMs: 0, limit: 65_536 },
    );
    cancelled(signal);
    // Esc exits 1 and Ctrl+C 130: either way, nothing is asked.
    if (result.code === 0) return result.stdout.replace(/\r?\n$/, '');
    if (result.code === 1 || result.code === 130) throw new Failure('cancelled', 'Cancelled.');
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  // readline swallows Ctrl+C; hand it to the process handler, which aborts `signal`.
  prompt.on('SIGINT', () => process.kill(process.pid, 'SIGINT'));
  try {
    return await prompt.question(colour(process.stderr) ? `${paint(palette.accent, '?')} ` : '? ', { signal });
  } catch (error) {
    cancelled(signal);
    throw error;
  } finally {
    prompt.close();
  }
}

// Markdown through gum format on a terminal; raw text otherwise, or if gum fails or
// renders nothing. The text goes after `--` as an argument: gum format ignores stdin
// unless it is a FIFO, and Node gives children a socket.
export async function renderAnswer(text: string, styled: boolean, signal: AbortSignal): Promise<string> {
  if (styled) {
    try {
      const rendered = (await gumText(['format', '--type=markdown', '--', text], signal)).replace(/^\n+/, '');
      if (rendered.trim()) return rendered + '\n';
    } catch {
      cancelled(signal);
    }
  }
  return text + '\n';
}
