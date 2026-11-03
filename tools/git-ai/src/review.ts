import { Failure, cancelled, diagnostic } from '../../shared/src/errors.ts';
import { run } from '../../shared/src/process.ts';
import { pickerDependency } from './model-picker.ts';
import { styleText } from '../../shared/src/gum.ts';
import { collectDoctor } from './doctor.ts';
import type { Config, ProviderName } from './config.ts';
import type { Proposal } from './fallback.ts';

export type Decision = 'accept' | 'retry' | 'edit' | 'reject' | 'cancel';

const choices = [
  ['accept', 'Accept — commit with this message'],
  ['retry', 'Try another provider…'],
  ['edit', 'Edit — open it in your editor first'],
  ['reject', 'Reject — cancel without committing'],
] as const;

const back = 'Back — keep the current message';

async function choose(header: string, labels: string[], signal: AbortSignal) {
  const result = await run('gum', ['choose', '--limit=1', '--selected=', '--timeout=0s', `--header=${header}`, '--', ...labels],
    { signal, interactive: true, timeoutMs: 0, limit: 4096 });
  cancelled(signal);
  return { code: result.code, picked: result.stdout.replace(/\r?\n$/, '') };
}

// Break one message line to fit the card, at spaces where possible. Continuations
// are marked so a soft wrap is never mistaken for a real line break in the message.
export function softWrap(line: string, width: number, marker = '↳ '): string[] {
  const chars = [...line];
  width = Math.max(1, width);
  if (chars.length <= width) return [line];
  const pieces: string[] = [];
  let rest = chars, limit = width;
  while (rest.length > limit) {
    const space = rest.slice(0, limit + 1).lastIndexOf(' ');
    const cut = space > 0 ? space : limit;
    pieces.push(rest.slice(0, cut).join(''));
    rest = rest.slice(space > 0 ? cut + 1 : cut);
    limit = Math.max(1, width - [...marker].length);
  }
  pieces.push(rest.join(''));
  return pieces.map((piece, i) => i === 0 ? piece : marker + piece);
}

// The proposal card: border 2 + padding 2 columns, so text gets the rest of the terminal.
export async function renderCard(proposal: Proposal, columns: number, signal: AbortSignal): Promise<string> {
  const inner = Math.max(20, columns - 4);
  const [subject, ...body] = proposal.message.split('\n');
  const source = `${proposal.provider} · ${diagnostic(proposal.model)} (${proposal.locality})`;
  const lines = [await styleText(signal, softWrap(subject, inner).join('\n'), '--bold'),
    ...body.flatMap(line => softWrap(line, inner))];
  return [await styleText(signal, softWrap(`Proposed commit message · ${source}`, columns, '').join('\n'), '--bold', '--foreground=141'),
    await styleText(signal, lines.join('\n'), '--border=rounded', '--border-foreground=141', '--padding=0 1')].join('\n');
}

// Print the proposal card on stderr, or plain text when gum cannot style it.
export async function showProposal(proposal: Proposal, signal: AbortSignal): Promise<void> {
  let card: string;
  try { card = await renderCard(proposal, process.stderr.columns || 80, signal); }
  catch {
    cancelled(signal);
    card = `Proposed commit message (${proposal.provider} · ${diagnostic(proposal.model)}):\n\n${proposal.message}\n`;
  }
  process.stderr.write(card + '\n');
}

// Show the validated proposal and ask what to do with it. Anything that stops gum
// from asking falls back to the editor, where the user can still abort.
export async function reviewMessage(proposal: Proposal, signal: AbortSignal, report: (line: string) => void): Promise<Decision> {
  try { await pickerDependency('gum', signal); }
  catch {
    cancelled(signal);
    report('gum is unavailable, so the proposal opens in your editor. Run make ensure-gum for the accept/edit/reject prompt.');
    return 'edit';
  }
  await showProposal(proposal, signal);
  const { code, picked } = await choose('Commit with this message?', choices.map(([, label]) => label), signal);
  if (code === 130) return 'cancel';
  // Esc leaves the prompt without a choice: treat it as a rejection.
  if (code === 1 && !picked.trim()) return 'reject';
  if (code !== 0) {
    report('gum prompt failed, so the proposal opens in your editor instead.');
    return 'edit';
  }
  const decision = choices.find(([, label]) => label === picked);
  if (!decision) throw new Failure('invalid-output', 'gum returned a choice outside the review options; nothing was committed.');
  return decision[0];
}

// Offer the providers that are ready right now, other than the one that wrote the
// current proposal. Policy is unchanged: blocked or unconfigured providers never appear.
export async function chooseProvider(config: Config, current: ProviderName, signal: AbortSignal,
  report: (line: string) => void): Promise<ProviderName | undefined> {
  process.stderr.write('\x1b[2mChecking providers…\x1b[0m');
  const doctor = await collectDoctor(config, signal);
  process.stderr.write('\r\x1b[2K');
  const ready = doctor.entries.filter(entry => entry.status === 'ready' && entry.name !== current);
  if (!ready.length) {
    report('No other provider is ready; keeping the current proposal. Run git ai doctor to see why.');
    return undefined;
  }
  const labels = ready.map(entry => `${entry.name} — ${diagnostic(entry.model)} (${entry.locality})`);
  const { code, picked } = await choose('Regenerate with which provider?', [...labels, back], signal);
  if (code === 130) throw new Failure('cancelled', 'Cancelled; nothing was committed.');
  if (code !== 0 || picked === back || !picked.trim()) return undefined;
  const index = labels.indexOf(picked);
  if (index < 0) throw new Failure('invalid-output', 'gum returned a choice outside the provider list; nothing was committed.');
  return ready[index].name;
}
