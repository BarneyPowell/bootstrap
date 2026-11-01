import { Failure, cancelled, diagnostic } from './errors.ts';
import { run } from './process.ts';
import { pickerDependency } from './model-picker.ts';
import { styleText } from './gum.ts';
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

// Show the validated proposal and ask what to do with it. Anything that stops gum
// from asking falls back to the editor, where the user can still abort.
export async function reviewMessage(proposal: Proposal, signal: AbortSignal, report: (line: string) => void): Promise<Decision> {
  try { await pickerDependency('gum', signal); }
  catch {
    cancelled(signal);
    report('gum is unavailable, so the proposal opens in your editor. Run make ensure-gum for the accept/edit/reject prompt.');
    return 'edit';
  }
  const [subject, ...body] = proposal.message.split('\n');
  const source = `${proposal.provider} · ${diagnostic(proposal.model)} (${proposal.locality})`;
  let card: string;
  try {
    const text = [await styleText(signal, subject, '--bold'), ...body].join('\n');
    card = [await styleText(signal, `Proposed commit message · ${source}`, '--bold', '--foreground=141'),
      await styleText(signal, text, '--border=rounded', '--border-foreground=141', '--padding=0 1')].join('\n');
  } catch {
    cancelled(signal);
    card = `Proposed commit message (${source}):\n\n${proposal.message}\n`;
  }
  process.stderr.write(card + '\n');
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
