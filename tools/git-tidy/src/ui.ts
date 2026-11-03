import { run } from '../../shared/src/process.ts';
import { Failure, cancelled } from '../../shared/src/errors.ts';
import { confirm as ask, palette, paint, styleText as style, table } from '../../shared/src/gum.ts';
import type { Candidate, Kept, Scan, Stale } from './branches.ts';
import type { Outcome } from './delete.ts';

const look = {
  merged: { glyph: '●', color: palette.ok },
  gone: { glyph: '○', color: palette.warn },
} as const;

export const plural = (count: number, word: string, suffix = 's') => `${count} ${word}${count === 1 ? '' : suffix}`;
const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - [...text].length));

export function keptLine(kept: Kept[]): string {
  return `Kept ${plural(kept.length, 'branch', 'es')}: ${kept.map(entry => `${entry.name} (${entry.reason})`).join(', ')}`;
}

const commits = (s: Stale) =>
  `${plural(s.notInMain, 'commit')} not in main${s.unpushed ? `, ${s.unpushed} unpushed` : ''}`;

// Log-friendly listing for --dry-run: one candidate, stale or kept branch per line.
export function plainLines(scan: Scan): string[] {
  const width = Math.max(0, ...[...scan.candidates, ...scan.stale, ...scan.kept].map(entry => [...entry.name].length));
  const totals = [
    `${scan.candidates.length} merged`,
    ...(scan.staleAfter ? [`${scan.stale.length} stale (no activity in ${scan.staleAfter.label})`] : []),
  ];
  return [
    ...scan.candidates.map(c => `${pad(c.kind, 6)}  ${pad(c.name, width)}  ${c.upstream} · ${c.age} · ${c.subject}`),
    ...scan.stale.map(
      s => `${pad('stale', 6)}  ${pad(s.name, width)}  ${s.upstream} · ${s.age} · ${commits(s)} · ${s.subject}`,
    ),
    ...scan.kept.map(entry => `${pad('kept', 6)}  ${pad(entry.name, width)}  ${entry.reason}`),
    scan.candidates.length || scan.stale.length
      ? `Can delete: ${totals.join(', ')} (vs ${scan.main.label}).`
      : `Nothing to tidy (vs ${scan.main.label}).`,
  ];
}

export async function renderPreview(scan: Scan, columns: number, signal: AbortSignal): Promise<string> {
  const width = Math.max(60, Math.min(columns, 120));
  const sections = [await style(signal, '◆ git tidy', '--bold', `--foreground=${palette.accent}`)];
  if (scan.candidates.length) {
    // The upstream column only earns its space when some branch tracks a differently named one.
    const upstreams = scan.candidates.some(c => c.upstream !== `${scan.remote}/${c.name}`);
    sections.push(
      await style(
        signal,
        `${plural(scan.candidates.length, 'local branch', 'es')} already merged into ${scan.main.label}`,
        '--faint',
      ),
      await table(
        signal,
        ['BRANCH', 'STATUS', ...(upstreams ? ['UPSTREAM'] : []), 'LAST COMMIT', 'SUBJECT'],
        scan.candidates.map(c => [
          c.name,
          paint(look[c.kind].color, `${look[c.kind].glyph} ${c.kind === 'gone' ? `gone from ${scan.remote}` : c.kind}`),
          ...(upstreams ? [c.upstream] : []),
          c.age,
          c.subject,
        ]),
        width,
      ),
    );
  }
  if (scan.stale.length && scan.staleAfter) {
    sections.push(
      await style(
        signal,
        `${plural(scan.stale.length, 'stale branch', 'es')}: no activity in ${scan.staleAfter.label} and not merged into ${scan.main.label}`,
        `--foreground=${palette.warn}`,
      ),
      await table(
        signal,
        ['BRANCH', 'UPSTREAM', 'LAST COMMIT', 'UNMERGED', 'UNPUSHED', 'SUBJECT'],
        scan.stale.map(s => [
          s.name,
          s.upstream,
          s.age,
          String(s.notInMain),
          s.unpushed ? paint(palette.bad, `⚠ ${s.unpushed}`) : paint(palette.ok, '0'),
          s.subject,
        ]),
        width,
      ),
    );
  }
  if (scan.kept.length)
    sections.push(await style(signal, keptLine(scan.kept), `--foreground=${palette.dim}`, `--width=${width}`));
  return sections.join('\n');
}

export async function renderOutcomes(title: string, outcomes: Outcome[], signal: AbortSignal): Promise<string> {
  const rows = outcomes.map(outcome =>
    outcome.ok ? paint(palette.ok, `✓ ${outcome.name}`) : paint(palette.bad, `✗ ${outcome.name} — ${outcome.detail}`),
  );
  return [await style(signal, title, '--bold', `--foreground=${palette.accent}`), ...rows].join('\n');
}

// Multi-select. Each option is shown as its label but gum returns its value, so
// decorated labels never have to be parsed back.
export async function choose(
  header: string,
  options: [label: string, value: string][],
  selectAll: boolean,
  signal: AbortSignal,
): Promise<string[] | 'cancel'> {
  const result = await run(
    'gum',
    [
      'choose',
      '--no-limit',
      `--selected=${selectAll ? '*' : ''}`,
      '--label-delimiter=\t',
      '--timeout=0s',
      `--header=${header}`,
      '--',
      ...options.map(([label, value]) => `${label}\t${value}`),
    ],
    { signal, interactive: true, timeoutMs: 0, limit: 65_536 },
  );
  cancelled(signal);
  if (result.code === 130) return 'cancel';
  // Esc leaves the prompt without a choice.
  if (result.code === 1 && !result.stdout.trim()) return [];
  if (result.code !== 0)
    throw new Failure('unavailable', 'gum selection failed; nothing was deleted. Check your gum installation.');
  const values = result.stdout.split(/\r?\n/).filter(Boolean);
  const known = new Set(options.map(([, value]) => value));
  if (values.some(value => !known.has(value)))
    throw new Failure('invalid-output', 'gum returned a choice outside the list; nothing was deleted.');
  return values;
}

export async function confirm(
  prompt: string,
  affirmative: string,
  safeDefault: boolean,
  signal: AbortSignal,
): Promise<'yes' | 'no' | 'cancel'> {
  try {
    return await ask(prompt, { affirmative, negative: 'Keep', safeDefault }, signal);
  } catch (error) {
    if (error instanceof Failure && error.kind === 'unavailable')
      throw new Failure('unavailable', 'gum confirm failed; nothing more was deleted. Check your gum installation.');
    throw error;
  }
}

export function branchLabels(candidates: Candidate[]): [string, string][] {
  const width = Math.max(...candidates.map(c => [...c.name].length));
  return candidates.map(c => [`${pad(c.name, width)}  ${look[c.kind].glyph} ${pad(c.kind, 6)}  ${c.age}`, c.name]);
}

export function staleLabels(stale: Stale[]): [string, string][] {
  const width = Math.max(...stale.map(s => [...s.name].length));
  return stale.map(s => [
    `${pad(s.name, width)}  ${s.age} · ${s.unpushed ? `⚠ ${s.unpushed} unpushed` : 'all pushed'}`,
    s.name,
  ]);
}
