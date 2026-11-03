import { parseArgs, help } from './args.ts';
import { loadConfig } from './config.ts';
import type { Proposal } from './fallback.ts';
import { Git } from './git.ts';
import { generateProposal } from './fallback.ts';
import { commit } from './commit.ts';
import { collectDoctor, plainLines, renderDoctor } from './doctor.ts';
import { pickerDependency } from './model-picker.ts';
import { reviewMessage, chooseProvider, showProposal } from './review.ts';
import { Failure, cancelled, diagnostic } from '../../shared/src/errors.ts';
import { selectOllamaModel } from './ollama-models.ts';
import { selectCodexModel } from './codex-models.ts';
import { selectClaudeModel } from './claude-models.ts';

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort(signal));
const report = (line: string) => process.stderr.write(`git-ai: ${diagnostic(line)}\n`);

async function main(): Promise<number> {
  const { command, options, scope } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === 'version') {
    process.stdout.write(command === 'help' ? help : 'git-ai 1.0.0\n');
    return 0;
  }
  if (command === 'commit' && !options.dryRun && !options.yolo && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Failure(
      'unavailable',
      'Commit review requires an interactive terminal. Use --dry-run for generation without an editor.',
    );
  const config = await loadConfig(options, undefined, controller.signal);
  if (command === 'ollama-models') return await selectOllamaModel(config, scope ?? 'global', controller.signal, report);
  if (command === 'codex-models') return await selectCodexModel(config, scope ?? 'global', controller.signal, report);
  if (command === 'claude-models') return await selectClaudeModel(config, scope ?? 'global', controller.signal, report);
  if (command === 'doctor') {
    // Styled output needs a terminal and gum; anything else (or any gum failure) prints plain lines.
    let styled = !options.plain && !!process.stderr.isTTY && !process.env.NO_COLOR;
    if (styled) {
      try {
        await pickerDependency('gum', controller.signal);
      } catch {
        cancelled(controller.signal);
        styled = false;
      }
    }
    if (styled) process.stderr.write('\x1b[2mChecking providers…\x1b[0m');
    const doctor = await collectDoctor(config, controller.signal);
    if (styled) {
      process.stderr.write('\r\x1b[2K');
      try {
        process.stderr.write((await renderDoctor(doctor, process.stderr.columns || 80, controller.signal)) + '\n');
        return 0;
      } catch {
        cancelled(controller.signal); /* fall back to plain output */
      }
    }
    for (const line of plainLines(doctor)) report(line);
    return 0;
  }
  const git = new Git(undefined, controller.signal);
  const snapshot = await git.collect(config.recentCount);
  const propose = async (settings: typeof config): Promise<Proposal> => {
    const proposal = await generateProposal(snapshot, settings, controller.signal, report, undefined, message =>
      git.validateCleanup(message),
    );
    await git.assertTree(snapshot.tree);
    return proposal;
  };
  let proposal = await propose(config);
  if (options.dryRun) {
    process.stdout.write(proposal.message + '\n');
    return 0;
  }
  if (options.yolo) {
    // No review: show what is being committed, then commit it exactly as proposed.
    await showProposal(proposal, controller.signal);
    return await commitProposal(git, snapshot.tree, proposal.message, false);
  }
  let decision = await reviewMessage(proposal, controller.signal, report);
  while (decision === 'retry') {
    const provider = await chooseProvider(config, proposal.provider, controller.signal, report);
    if (provider) {
      try {
        // Same staged snapshot, chosen provider pinned (no fallback); cloud policy still applies.
        proposal = await propose(await loadConfig({ provider }, undefined, controller.signal));
      } catch (error) {
        if (!(error instanceof Failure) || ['cancelled', 'git-error'].includes(error.kind)) throw error;
        report(`${provider} could not produce a message (${error.kind}); keeping the previous proposal.`);
      }
    }
    decision = await reviewMessage(proposal, controller.signal, report);
  }
  if (decision === 'reject' || decision === 'cancel') {
    report(decision === 'reject' ? 'Proposal rejected; nothing was committed.' : 'Cancelled; nothing was committed.');
    return decision === 'reject' ? 1 : 130;
  }
  return await commitProposal(git, snapshot.tree, proposal.message, decision === 'edit');
}

async function commitProposal(git: Git, tree: string, message: string, edit: boolean): Promise<number> {
  const code = await commit(git, tree, message, edit);
  if (code !== 0) {
    try {
      const path = await git.text(['rev-parse', '--path-format=absolute', '--git-path', 'COMMIT_EDITMSG']);
      report(
        `Git exited ${code}. If Git retained the edited message, find it at ${path}. No regeneration or commit retry was attempted.`,
      );
    } catch {
      report(
        `Git exited ${code}. Check Git's COMMIT_EDITMSG for recovery. No regeneration or commit retry was attempted.`,
      );
    }
  }
  return code;
}

try {
  process.exitCode = await main();
} catch (error) {
  report(
    error instanceof Failure
      ? `${error.kind}: ${error.message}`
      : 'Unexpected failure; raw diagnostics suppressed. Run git ai doctor.',
  );
  process.exitCode = controller.signal.aborted
    ? controller.signal.reason === 'SIGTERM'
      ? 143
      : 130
    : error instanceof Failure && error.kind === 'cancelled'
      ? 130
      : 1;
}
