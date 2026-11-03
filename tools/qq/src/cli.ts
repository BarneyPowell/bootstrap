import { fstatSync } from 'node:fs';
import { parseArgs, help, version } from './args.ts';
import { ask, NoAnswer } from './ask.ts';
import { buildPrompt, detectEnvironment, maxContextBytes, qqTask } from './prompt.ts';
import { readQuestion, renderAnswer } from './ui.ts';
import { configReader, loadAiConfig } from '../../shared/src/ai/config.ts';
import { Failure, diagnostic } from '../../shared/src/errors.ts';
import { paint, palette } from '../../shared/src/gum.ts';
import { Spinner, colour } from '../../shared/src/terminal.ts';

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort(signal));
const report = (line: string) => process.stderr.write(`qq: ${diagnostic(line)}\n`);

// Text piped or redirected into qq. A terminal, or anything that is not a pipe,
// socket or file (such as /dev/null), is not read, so qq never waits on it.
async function readPiped(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  try {
    const stat = fstatSync(0);
    if (!stat.isFIFO() && !stat.isFile() && !stat.isSocket()) return undefined;
  } catch { return undefined; }
  let data = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    data = Buffer.concat([data, chunk as Buffer]);
    // Only the tail is ever sent, so do not hold more than a few times that.
    if (data.length > 4 * maxContextBytes) data = data.subarray(data.length - 2 * maxContextBytes);
  }
  return data.toString('utf8');
}

async function main(): Promise<number> {
  const { command, options, question: words } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === 'version') {
    process.stdout.write(command === 'help' ? help : `${version}\n`);
    return 0;
  }
  const signal = controller.signal;
  const piped = await readPiped();
  let question = words, context: string | undefined;
  if (question) context = piped;
  else if (piped?.trim()) question = piped.trim();
  else if (piped !== undefined || !process.stdin.isTTY || !process.stderr.isTTY)
    throw new Failure('configuration-invalid', 'No question given. Usage: qq <question>, or run qq in a terminal to type one.');
  else {
    question = (await readQuestion(signal)).trim();
    if (!question) return 0;
  }
  const config = await loadAiConfig(options, configReader(undefined, signal), 'qq');
  const task = qqTask(await detectEnvironment(signal));
  const spinner = new Spinner();
  let answer;
  try { answer = await ask(buildPrompt(question, context), config, task, signal, name => spinner.update(`Asking ${name}…`)); }
  finally { spinner.stop(); }
  const styled = !options.plain && colour(process.stdout);
  process.stdout.write(await renderAnswer(answer.text, styled, signal));
  if (process.stderr.isTTY) {
    const source = `${answer.provider} · ${diagnostic(answer.model)}${answer.locality === 'local' ? ' (local)' : ''}`;
    process.stderr.write(`${colour(process.stderr) ? paint(palette.dim, source) : source}\n`);
  }
  return 0;
}

try { process.exitCode = await main(); }
catch (error) {
  if (error instanceof NoAnswer) {
    report('no provider answered:');
    for (const line of error.failures) process.stderr.write(`  ${line}\n`);
    report('check providers with git ai doctor; qq --help explains the settings.');
  } else report(error instanceof Failure ? `${error.kind}: ${error.message}` : 'Unexpected failure; raw diagnostics suppressed.');
  process.exitCode = controller.signal.aborted ? (controller.signal.reason === 'SIGTERM' ? 143 : 130) : error instanceof Failure && error.kind === 'cancelled' ? 130 : 1;
}
