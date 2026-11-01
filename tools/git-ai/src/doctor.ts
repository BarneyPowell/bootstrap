import { platform, release, homedir } from 'node:os';
import type { Config, ProviderName } from './config.ts';
import { providers } from './config.ts';
import { Failure, cancelled, diagnostic } from './errors.ts';
import { createAdapter, executableVersion } from './providers.ts';
import { gumText as gum, styleText as style } from './gum.ts';

export type Status = 'ready' | 'blocked' | 'unavailable' | 'not-configured';
export type DoctorEntry = {
  name: ProviderName; model: string; effort: string; status: Status;
  locality?: 'local' | 'remote'; label: string; detail: string;
  // undefined: not applicable; null: executable version unavailable.
  version?: string | null;
};
export type DoctorReport = {
  os: string; node: string; cloud: boolean; order: ProviderName[]; timeoutSeconds: number;
  contextFallback: string; recentCount: number; origins: [string, string][]; entries: DoctorEntry[];
};

function statusOf(error: unknown, timedOut: boolean): Status {
  if (timedOut) return 'unavailable';
  if (error instanceof Failure && error.kind === 'privacy-blocked') return 'blocked';
  if (error instanceof Failure && error.kind === 'model-not-configured') return 'not-configured';
  return 'unavailable';
}

async function inspect(name: ProviderName, config: Config, signal: AbortSignal): Promise<DoctorEntry> {
  const entry: DoctorEntry = { name, status: 'unavailable', label: '', detail: '',
    model: config.models[name] ?? (name === 'apple' ? 'system' : '(not configured)'),
    effort: config.efforts[name] ?? '(not set)' };
  if (name === 'codex' || name === 'claude') {
    try { entry.version = await executableVersion(name, signal); }
    catch { entry.version = null; }
  }
  const timeout = AbortSignal.timeout(Math.min(config.timeoutSeconds * 1000, 3000));
  try {
    const info = await createAdapter(name, config).probe(AbortSignal.any([signal, timeout]));
    entry.status = 'ready';
    entry.locality = info.locality;
    entry.detail = info.detail;
  } catch (error) {
    cancelled(signal);
    entry.status = statusOf(error, timeout.aborted);
    entry.label = timeout.aborted ? 'timeout' : error instanceof Failure ? error.kind : 'unavailable';
    entry.detail = error instanceof Failure ? error.message : 'Probe failed; raw logs suppressed.';
  }
  return entry;
}

// Providers are independent, so probe them concurrently; the order of the report is fixed.
export async function collectDoctor(config: Config, signal: AbortSignal): Promise<DoctorReport> {
  const entries = await Promise.all(providers.map(name => inspect(name, config, signal)));
  cancelled(signal);
  return { os: `${platform()} ${release()}`, node: process.version, cloud: config.allowCloud, order: config.providers,
    timeoutSeconds: config.timeoutSeconds, contextFallback: config.contextFallback, recentCount: config.recentCount,
    origins: Object.entries(config.origins), entries };
}

// Log-friendly output: one fact per line, no colour. Used for pipes, NO_COLOR and --plain.
export function plainLines(report: DoctorReport): string[] {
  const lines = [
    `OS=${report.os}; Node=${report.node}; cloud=${report.cloud ? 'allowed' : 'blocked'}`,
    `provider order=${report.order.join(' -> ')}; deadline=${report.timeoutSeconds}s per provider`,
    `context fallback=${report.contextFallback}; ai.allowCloud remains the cloud gate`,
    ...report.origins.map(([key, origin]) => `${key} origin=${origin}`),
  ];
  for (const entry of report.entries) {
    lines.push(`${entry.name}: model=${entry.model}; reasoning=${entry.effort}`);
    if (entry.version !== undefined)
      lines.push(entry.version === null ? `${entry.name}: executable version unavailable`
        : `${entry.name}: executable version=${entry.version}; authentication and model access unverified`);
    lines.push(entry.status === 'ready' ? `${entry.name}: ${entry.locality}; ${entry.detail}`
      : `${entry.name}: ${entry.label}: ${entry.detail}`);
  }
  return lines;
}

// ---- gum rendering --------------------------------------------------------------------------

const palette = { accent: '141', ok: '78', warn: '214', bad: '203', dim: '245', text: '252', rule: '240' };
const look: Record<Status, { glyph: string; color: string; word: string }> = {
  ready: { glyph: '●', color: palette.ok, word: 'ready' },
  blocked: { glyph: '◐', color: palette.warn, word: 'blocked' },
  unavailable: { glyph: '✗', color: palette.bad, word: 'unavailable' },
  'not-configured': { glyph: '○', color: palette.dim, word: 'not configured' },
};

const ansi = /\x1b\[[0-9;]*m/g;
const visible = (text: string) => [...text.replace(ansi, '')].length;
// gum table gives its first row a "selected" bold; 22 restores normal intensity inside each cell.
const paint = (color: string, text: string) => `\x1b[22m\x1b[38;5;${color}m${text}\x1b[0m`;

function fitWidths(headers: string[], rows: string[][], limit: number): number[] {
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
function truncate(cell: string, limit: number): string {
  if (ansi.test(cell) || visible(cell) <= limit) return cell;
  return [...cell].slice(0, Math.max(1, limit - 1)).join('') + '…';
}

// Word-wrap with a hanging indent so wrapped bullets stay visibly part of their bullet.
export function wrap(text: string, width: number, first: string, rest: string): string {
  const lines: string[] = [];
  let line = first;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const separator = line === first || line === rest ? '' : ' ';
    if ([...(line + separator + word)].length > width && line !== first && line !== rest) { lines.push(line); line = rest + word; }
    else line += separator + word;
  }
  lines.push(line);
  return lines.join('\n');
}

async function table(signal: AbortSignal, headers: string[], rows: string[][], width: number): Promise<string> {
  const widths = fitWidths(headers, rows, width);
  const csv = rows.map(row => row.map((cell, i) => `"${truncate(cell, widths[i]).replace(/"/g, '""')}"`).join(',')).join('\n');
  return await gum(['table', '--print', '--border=rounded', `--columns=${headers.join(',')}`,
    `--widths=${widths.join(',')}`, `--border.foreground=${palette.rule}`,
    `--header.foreground=${palette.accent}`, `--cell.foreground=${palette.text}`, '--selected.foreground='], signal, csv);
}

const heading = (signal: AbortSignal, text: string) => style(signal, `▍ ${text}`, '--bold', `--foreground=${palette.accent}`);
const shorten = (origin: string) => {
  if (origin === 'command line:') return 'command line / GIT_CONFIG_* env';
  return diagnostic(origin.replace(/^file:/, '').replace(homedir(), '~'));
};

// Concrete next steps for the problems the probes actually found.
export function nextSteps(report: DoctorReport): string[] {
  const steps: string[] = [];
  for (const entry of report.entries) {
    if (entry.status === 'not-configured') {
      steps.push(entry.name === 'apple' ? `${entry.name}: check fm models and Apple Intelligence readiness`
        : `${entry.name}: choose a model with  git ai ${entry.name} models   or set  ai.${entry.name}.model`);
    } else if (entry.status === 'blocked') {
      steps.push(`${entry.name}: remote inference is off; enable it only if you want it with  git config --global ai.allowCloud true`);
    } else if (entry.status === 'unavailable') {
      steps.push(entry.label === 'timeout' ? `${entry.name}: timed out; raise ai.timeoutSeconds or check the service`
        : `${entry.name}: ${entry.detail}`);
    }
  }
  return steps;
}

export async function renderDoctor(report: DoctorReport, columns: number, signal: AbortSignal): Promise<string> {
  const width = Math.max(60, Math.min(columns, 100));
  const ready = report.entries.filter(entry => entry.status === 'ready').length;
  const total = report.entries.length;
  const attention = total - ready;

  const banner = await style(signal, [
    await style(signal, '◆ git ai doctor', '--bold', `--foreground=${palette.accent}`),
    await style(signal, `${report.os} · Node ${report.node}`, '--faint'),
    await style(signal, attention ? `${ready} of ${total} providers ready · ${attention} need attention` : `all ${total} providers ready`,
      `--foreground=${attention ? palette.warn : palette.ok}`),
  ].join('\n'), '--border=double', `--border-foreground=${palette.accent}`, '--padding=0 2', `--width=${width - 2}`);

  const policy = await table(signal, ['POLICY', 'VALUE'], [
    ['Cloud inference', report.cloud ? paint(palette.warn, 'allowed') + ' (ai.allowCloud=true)' : paint(palette.ok, 'blocked') + ' (ai.allowCloud=false)'],
    ['Provider order', report.order.join(' → ')],
    ['Deadline', `${report.timeoutSeconds}s per provider`],
    ['Context fallback', `${report.contextFallback} · Codex if local context is too small`],
    ['History in prompt', `${report.recentCount} recent subject${report.recentCount === 1 ? '' : 's'}`],
  ], width);

  const providerTable = await table(signal, ['PROVIDER', 'STATUS', 'WHERE', 'MODEL', 'EFFORT'], report.entries.map(entry => {
    const { glyph, color, word } = look[entry.status];
    return [entry.name, paint(color, `${glyph} ${word}`), entry.locality ?? '–', diagnostic(entry.model), entry.effort === '(not set)' ? '–' : diagnostic(entry.effort)];
  }), width);

  const cards: string[] = [];
  for (const entry of report.entries) {
    const { glyph, color, word } = look[entry.status];
    const title = await style(signal, `${glyph} ${entry.name} — ${word}${entry.locality ? ` · ${entry.locality}` : ''}`, '--bold', `--foreground=${color}`);
    const version = entry.version === undefined ? '' : entry.version === null ? '\nCLI: not found on PATH' : `\nCLI: ${diagnostic(entry.version)}`;
    const body = await style(signal, (entry.status === 'ready' ? diagnostic(entry.detail) : `${entry.label}: ${diagnostic(entry.detail)}`) + version,
      `--foreground=${palette.dim}`, `--width=${width - 6}`);
    cards.push(await style(signal, `${title}\n${body}`, '--border=rounded', `--border-foreground=${color}`, '--padding=0 1', `--width=${width - 2}`));
  }

  const sections = [banner, '', await heading(signal, 'Policy'), policy, '', await heading(signal, 'Providers'), providerTable, '',
    await heading(signal, 'Details'), ...cards];

  if (report.origins.length) {
    sections.push('', await heading(signal, 'Settings in effect'),
      await table(signal, ['KEY', 'SET IN'], report.origins.map(([key, origin]) => [key, shorten(origin)]), width));
  }

  const steps = nextSteps(report);
  sections.push('', steps.length
    ? await style(signal, [await style(signal, 'Next steps', '--bold', `--foreground=${palette.warn}`),
      ...steps.map(step => wrap(diagnostic(step), width - 6, '• ', '  '))].join('\n'),
      '--border=rounded', `--border-foreground=${palette.warn}`, '--padding=0 1', `--width=${width - 2}`)
    : await style(signal, '✓ Everything configured is ready. Try  git ai commit --dry-run', `--foreground=${palette.ok}`, '--bold'));
  sections.push(await style(signal, 'Plain, log-friendly output: git ai doctor --plain', '--faint'));
  return sections.join('\n');
}
