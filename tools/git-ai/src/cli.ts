import { parseArgs, help } from './args.ts';
import { loadConfig, providers } from './config.ts';
import { Git } from './git.ts';
import { generate } from './fallback.ts';
import { commit } from './commit.ts';
import { createAdapter, executableVersion } from './providers.ts';
import { Failure, diagnostic } from './errors.ts';
import { platform, release } from 'node:os';

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort(signal));
const report = (line: string) => process.stderr.write(`git-ai: ${diagnostic(line)}\n`);

async function main(): Promise<number> {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === 'version') {
    process.stdout.write(command === 'help' ? help : 'git-ai 1.0.0\n');
    return 0;
  }
  if (command === 'commit' && !options.dryRun && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Failure('unavailable', 'Commit review requires an interactive terminal. Use --dry-run for generation without an editor.');
  const config = await loadConfig(options, undefined, controller.signal);
  if (command === 'doctor') {
    report(`OS=${platform()} ${release()}; Node=${process.version}; cloud=${config.allowCloud ? 'allowed' : 'blocked'}`);
    report(`provider order=${config.providers.join(' -> ')}; deadline=${config.timeoutSeconds}s per provider`);
    for (const [key, origin] of Object.entries(config.origins)) report(`${key} origin=${origin}`);
    for (const name of providers) {
      report(`${name}: model=${config.models[name] ?? (name === 'apple' ? 'system' : '(not configured)')}; reasoning=${config.efforts[name] ?? '(not set)'}`);
      if (name === 'codex' || name === 'claude') {
        try {
          const version = await executableVersion(name, controller.signal);
          report(`${name}: executable version=${version}; authentication and model access unverified`);
        } catch { report(`${name}: executable version unavailable`); }
      }
      const timeout = AbortSignal.timeout(Math.min(config.timeoutSeconds * 1000, 3000));
      try {
        const info = await createAdapter(name, config).probe(AbortSignal.any([controller.signal, timeout]));
        report(`${name}: ${info.locality}; ${info.detail}`);
      } catch (error) {
        if (controller.signal.aborted) throw new Failure('cancelled', 'Cancelled.');
        report(`${name}: ${timeout.aborted ? 'timeout' : error instanceof Failure ? error.kind : 'unavailable'}: ${error instanceof Failure ? error.message : 'Probe failed; raw logs suppressed.'}`);
      }
    }
    return 0;
  }
  const git = new Git(undefined, controller.signal);
  const snapshot = await git.collect(config.recentCount);
  const message = await generate(snapshot, config, controller.signal, report, undefined, message => git.validateCleanup(message));
  await git.assertTree(snapshot.tree);
  if (options.dryRun) { process.stdout.write(message + '\n'); return 0; }
  const code = await commit(git, snapshot.tree, message);
  if (code !== 0) {
    try {
      const path = await git.text(['rev-parse', '--path-format=absolute', '--git-path', 'COMMIT_EDITMSG']);
      report(`Git exited ${code}. If Git retained the edited message, find it at ${path}. No regeneration or commit retry was attempted.`);
    } catch {
      report(`Git exited ${code}. Check Git's COMMIT_EDITMSG for recovery. No regeneration or commit retry was attempted.`);
    }
  }
  return code;
}

try { process.exitCode = await main(); }
catch (error) {
  report(error instanceof Failure ? `${error.kind}: ${error.message}` : 'Unexpected failure; raw diagnostics suppressed. Run git ai doctor.');
  process.exitCode = controller.signal.aborted ? (controller.signal.reason === 'SIGTERM' ? 143 : 130) : 1;
}
