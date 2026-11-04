import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireCommand, run, scratch } from './process.ts';
import { Failure, cancelled, diagnostic } from './errors.ts';

export const palette = { accent: '141', ok: '78', warn: '214', bad: '203', dim: '245', text: '252', rule: '240' };

export const requireGum = (signal: AbortSignal) =>
  requireCommand('gum', 'gum is unavailable. Run make ensure-gum from the bootstrap clone, then retry.', signal);

// Run gum for its rendered text. gum drops colour when its output is a pipe, so
// colour is forced; callers write the captured text to the terminal themselves.
// gum gets no stdin: Node hands a child a socket, which gum takes for no input at all.
export async function gumText(args: string[], signal: AbortSignal): Promise<string> {
  const result = await run('gum', args, {
    signal,
    env: { ...process.env, CLICOLOR_FORCE: '1' },
    timeoutMs: 5000,
  });
  if (result.code !== 0) {
    // gum prints some errors (such as "no data provided") on stdout, so look at both.
    const reason = (result.stderr.trim() || result.stdout.trim()).split('\n')[0];
    throw new Failure('unavailable', `gum rendering failed${reason ? `: ${diagnostic(reason.slice(0, 200))}` : ''}.`);
  }
  return result.stdout.replace(/\n$/, '');
}

// Ask a yes/no question on the terminal. No and Esc both answer 'no'; Ctrl+C is 'cancel'.
// A safe default starts the prompt on the negative answer.
export type ConfirmOptions = { affirmative: string; negative: string; safeDefault: boolean };
export async function confirm(
  prompt: string,
  options: ConfirmOptions,
  signal: AbortSignal,
): Promise<'yes' | 'no' | 'cancel'> {
  const result = await run(
    'gum',
    [
      'confirm',
      `--affirmative=${options.affirmative}`,
      `--negative=${options.negative}`,
      `--default=${options.safeDefault ? 'false' : 'true'}`,
      '--timeout=0s',
      '--',
      prompt,
    ],
    { signal, interactive: true, timeoutMs: 0, limit: 4096 },
  );
  cancelled(signal);
  if (result.code === 0) return 'yes';
  if (result.code === 1) return 'no';
  if (result.code === 130) return 'cancel';
  throw new Failure('unavailable', 'gum confirm failed. Check your gum installation.');
}

// Text is passed after `--` as a plain argument: never a template, never a flag.
export const styleText = (signal: AbortSignal, text: string, ...flags: string[]) =>
  gumText(['style', ...flags, '--', text], signal);

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
  const csv = rows
    .map(row => row.map((cell, i) => `"${truncate(cell, widths[i]).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  // The rows go through a private file: gum table ignores stdin when it isn't a pipe or a file.
  return await scratch('gum-table-', async directory => {
    const file = join(directory, 'rows.csv');
    await writeFile(file, csv + '\n', { mode: 0o600 });
    return await gumText(
      [
        'table',
        '--print',
        `--file=${file}`,
        '--border=rounded',
        `--columns=${headers.join(',')}`,
        `--widths=${widths.join(',')}`,
        `--border.foreground=${palette.rule}`,
        `--header.foreground=${palette.accent}`,
        `--cell.foreground=${palette.text}`,
        '--selected.foreground=',
      ],
      signal,
    );
  });
}
