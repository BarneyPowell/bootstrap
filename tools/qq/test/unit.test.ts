import './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.ts';
import { buildPrompt, instructions, maxContextBytes, qqTask, trimContext } from '../src/prompt.ts';
import { ask, NoAnswer } from '../src/ask.ts';
import { renderAnswer } from '../src/ui.ts';
import { Failure } from '../../shared/src/errors.ts';
import type { Adapter, Capabilities } from '../../shared/src/ai/providers.ts';
import type { ProviderName } from '../../shared/src/ai/config.ts';
import { config } from './helpers.ts';

const signal = () => AbortSignal.timeout(5000);
const task = qqTask({ os: 'Linux (Test OS)', shell: 'zsh' });

test('arguments: options come before the question; everything after is the question', () => {
  assert.deepEqual(parseArgs(['How', 'do', 'I', 'see', 'members?']), { command: 'ask', options: {}, question: 'How do I see members?' });
  assert.deepEqual(parseArgs([]), { command: 'ask', options: {}, question: '' });
  assert.equal(parseArgs(['--help']).command, 'help');
  assert.equal(parseArgs(['-h']).command, 'help');
  assert.equal(parseArgs(['--version']).command, 'version');
  assert.deepEqual(parseArgs(['--plain', '--provider', 'claude', '--model', 'm', '--reasoning-effort', 'low', 'why?']),
    { command: 'ask', options: { plain: true, provider: 'claude', model: 'm', reasoningEffort: 'low' }, question: 'why?' });
  // Flags inside the question are part of it.
  assert.equal(parseArgs(['what', 'does', 'git', 'push', '--force', 'do']).question, 'what does git push --force do');
  assert.equal(parseArgs(['what', 'does', '--help', 'show']).command, 'ask');
  assert.equal(parseArgs(['--', '-rf', 'means', 'what']).question, '-rf means what');
  for (const [args, pattern] of [
    [['--bogus', 'x'], /Unknown option: --bogus/],
    [['--plain', '--plain', 'x'], /Repeated option/],
    [['--provider'], /Missing value/],
    [['--provider', '--plain'], /Missing value/],
    [['--provider', 'gpt', 'x'], /Unknown provider/],
    [['--model', 'm', 'x'], /require --provider/],
  ] as const) assert.throws(() => parseArgs([...args]), (e: any) => e instanceof Failure && pattern.test(e.message));
});

test('prompt: instructions describe the machine; piped context is fenced and keeps its tail', () => {
  const text = instructions({ os: 'Linux (Test OS)', shell: 'fish' });
  assert.match(text, /Linux \(Test OS\), using fish/);
  assert.match(text, /untrusted data/);
  assert.equal(task.instructions, instructions({ os: 'Linux (Test OS)', shell: 'zsh' }));
  assert.equal(task.selfContained, false);
  assert.equal(buildPrompt('why?'), 'why?');
  assert.equal(buildPrompt('why?', '  \n'), 'why?');
  const prompt = buildPrompt('what failed?', 'line 1\nERROR: disk full\n');
  assert.equal(prompt, 'what failed?\n\nCONTEXT (piped input):\n<<<CONTEXT\nline 1\nERROR: disk full\nCONTEXT>>>');
  const long = 'x'.repeat(maxContextBytes) + 'THE END';
  const trimmed = buildPrompt('what?', long);
  assert.match(trimmed, /only the last 32768 bytes/);
  assert.match(trimmed, /THE END\nCONTEXT>>>$/);
  assert.ok(!trimmed.includes('x'.repeat(maxContextBytes)));
  // Never splits a multi-byte character.
  const cut = trimContext('é'.repeat(10), 5);
  assert.equal(cut.text, 'éé');
  assert.equal(cut.truncated, true);
});

type Script = Partial<Record<ProviderName, { probe?: Error | Partial<Capabilities>; answer?: string | Error; hang?: boolean }>>;

function mock(script: Script, calls: string[]) {
  return (name: ProviderName): Adapter => ({
    name,
    async probe() {
      calls.push(`${name}:probe`);
      const probe = script[name]?.probe;
      if (probe instanceof Error) throw probe;
      return { model: `${name}-model`, locality: 'local', inputBytes: 1000, detail: '', ...probe };
    },
    async generate(prompt, signal) {
      calls.push(`${name}:generate:${prompt}`);
      if (script[name]?.hang) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      const answer = script[name]?.answer ?? `${name} says hi`;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
}

test('ask: first answer wins; failures fall through in order', async () => {
  const calls: string[] = [];
  const attempts: string[] = [];
  const answer = await ask('q', config(), task, signal(), name => attempts.push(name), mock({
    apple: { probe: new Failure('unavailable', 'no fm') },
    ollama: { answer: '   \n' },
    codex: { answer: '  codex answer\n' },
  }, calls));
  assert.deepEqual(answer, { text: 'codex answer', provider: 'codex', model: 'codex-model', locality: 'local' });
  assert.deepEqual(attempts, ['apple', 'ollama', 'codex']);
  assert.deepEqual(calls, ['apple:probe', 'ollama:probe', 'ollama:generate:q', 'codex:probe', 'codex:generate:q']);
});

test('ask: remote providers need ai.allowCloud, and oversized prompts are skipped before sending', async () => {
  const calls: string[] = [];
  const script: Script = { apple: { probe: { inputBytes: 3 } }, ollama: { probe: { locality: 'remote' } }, codex: { probe: { locality: 'remote' } } };
  await assert.rejects(ask('long question', config({ providers: ['apple', 'ollama'] }), task, signal(), undefined, mock(script, calls)),
    (e: any) => e instanceof NoAnswer && /apple: context-too-large/.test(e.failures[0]) && /ollama: privacy-blocked/.test(e.failures[1]));
  assert.ok(!calls.some(call => call.includes('generate')));
  const allowed = await ask('q', config({ providers: ['codex'], allowCloud: true }), task, signal(), undefined, mock(script, calls));
  assert.equal(allowed.locality, 'remote');
});

test('ask: configuration errors and cancellation stop the search; timeouts move on', async () => {
  const calls: string[] = [];
  await assert.rejects(ask('q', config(), task, signal(), undefined,
    mock({ apple: { answer: new Failure('configuration-invalid', 'bad model') } }, calls)), (e: any) => e.kind === 'configuration-invalid');
  assert.ok(!calls.includes('ollama:probe'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(ask('q', config(), task, controller.signal, undefined, mock({}, [])), (e: any) => e.kind === 'cancelled');
  const answer = await ask('q', config({ providers: ['apple', 'ollama'], timeoutSeconds: 1 }), task, signal(), undefined,
    mock({ apple: { hang: true } }, []));
  assert.equal(answer.provider, 'ollama');
  await assert.rejects(ask('q', config({ providers: ['apple'], timeoutSeconds: 1 }), task, signal(), undefined, mock({ apple: { hang: true } }, [])),
    (e: any) => e instanceof NoAnswer && /apple: timeout: No answer within 1s/.test(e.failures[0]));
  await assert.rejects(ask('q', config({ providers: ['apple'] }), task, signal(), undefined, mock({ apple: { answer: new Error('PRIVATE raw') } }, [])),
    (e: any) => e instanceof NoAnswer && !e.failures[0].includes('PRIVATE') && /transport\/service-error/.test(e.failures[0]));
});

test('render: plain output is the raw answer', async () => {
  assert.equal(await renderAnswer('**hi**', false, signal()), '**hi**\n');
});
