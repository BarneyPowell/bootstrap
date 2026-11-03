import { requireCommand, run } from './process.ts';
import { Failure, cancelled } from './errors.ts';

export const palette = { accent: '141', ok: '78', warn: '214', bad: '203', dim: '245', text: '252', rule: '240' };

export const requireGum = (signal: AbortSignal) =>
  requireCommand('gum', 'gum is unavailable. Run make ensure-gum from the bootstrap clone, then retry.', signal);

// Run gum for its rendered text. gum drops colour when its output is a pipe, so
// colour is forced; callers write the captured text to the terminal themselves.
export async function gumText(args: string[], signal: AbortSignal, input?: string): Promise<string> {
  const result = await run('gum', args, { signal, input, env: { ...process.env, CLICOLOR_FORCE: '1' }, timeoutMs: 5000 });
  if (result.code !== 0) throw new Failure('unavailable', 'gum rendering failed.');
  return result.stdout.replace(/\n$/, '');
}

// Ask a yes/no question on the terminal. No and Esc both answer 'no'; Ctrl+C is 'cancel'.
// A safe default starts the prompt on the negative answer.
export type ConfirmOptions = { affirmative: string; negative: string; safeDefault: boolean };
export async function confirm(prompt: string, options: ConfirmOptions, signal: AbortSignal): Promise<'yes' | 'no' | 'cancel'> {
  const result = await run('gum', ['confirm', `--affirmative=${options.affirmative}`, `--negative=${options.negative}`,
    `--default=${options.safeDefault ? 'false' : 'true'}`, '--timeout=0s', '--', prompt], { signal, interactive: true, timeoutMs: 0, limit: 4096 });
  cancelled(signal);
  if (result.code === 0) return 'yes';
  if (result.code === 1) return 'no';
  if (result.code === 130) return 'cancel';
  throw new Failure('unavailable', 'gum confirm failed. Check your gum installation.');
}

// Text is passed after `--` as a plain argument: never a template, never a flag.
export const styleText = (signal: AbortSignal, text: string, ...flags: string[]) => gumText(['style', ...flags, '--', text], signal);

const ansi = /\x1b\[[0-9;]*m/g;
export const visible = (text: string) => [...text.replace(ansi, '')].length;
// gum table gives its first row a "selected" bold; 22 restores normal intensity inside each cell.
export const paint = (color: string, text: string) => `\x1b[22m\x1b[38;5;${color}m${text}\x1b[0m`;

export function fitWidths(headers: string[], rows: string[][], limit: number): number[] {
  const widths = headers.map((header, i) => Math.max(visible(header), ...rows.map(row => visible(row[i] ?? ''))));
  const chrome = headers.length * 3 + 1;
  while (widths.reduce((a, b) => a + b, 0) + chrome > limit) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= 8) break;
    widths[widest]--;
  }
  return widths;
}

// gum table only ever widens a column, so cut over-long plain cells down to the fitted width.
// Painted cells are left whole: cutting them could split an escape sequence.
export function truncate(cell: string, limit: number): string {
  if (visible(cell) !== [...cell].length || visible(cell) <= limit) return cell;
  return [...cell].slice(0, Math.max(1, limit - 1)).join('') + '…';
}

export async function table(signal: AbortSignal, headers: string[], rows: string[][], width: number): Promise<string> {
  const widths = fitWidths(headers, rows, width);
  const csv = rows.map(row => row.map((cell, i) => `"${truncate(cell, widths[i]).replace(/"/g, '""')}"`).join(',')).join('\n');
  return await gumText(['table', '--print', '--border=rounded', `--columns=${headers.join(',')}`,
    `--widths=${widths.join(',')}`, `--border.foreground=${palette.rule}`,
    `--header.foreground=${palette.accent}`, `--cell.foreground=${palette.text}`, '--selected.foreground='], signal, csv);
}
