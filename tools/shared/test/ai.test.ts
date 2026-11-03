import './git-env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { configReader, loadAiConfig } from '../src/ai/config.ts';
import type { AiConfig } from '../src/ai/config.ts';
import { createAdapter } from '../src/ai/providers.ts';
import type { Task } from '../src/ai/providers.ts';

const signal = () => AbortSignal.timeout(5000);
const task = (overrides: Partial<Task> = {}): Task => ({
  tool: 'test-tool', instructions: 'SYSTEM INSTRUCTIONS', selfContained: false,
  maxOutputTokens: 777, maxOutputBytes: 100, temperature: 0.5, ...overrides,
});
const config = (overrides: Partial<AiConfig> = {}): AiConfig => ({
  providers: ['apple', 'ollama', 'codex', 'claude'], allowCloud: false, timeoutSeconds: 2, pinned: false,
  endpoint: 'http://127.0.0.1:11434', maxContext: { apple: 4096, ollama: 8192 }, ollamaKeepAlive: '0',
  models: {}, efforts: {}, origins: {}, ...overrides,
});

async function repository(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'shared-ai-test-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q'], { cwd: directory });
  return directory;
}
const set = (cwd: string, key: string, value: string) => execFileSync('git', ['config', key, value], { cwd });

test('a tool scope overrides the shared provider order and deadline, falling back to ai.*', async t => {
  const directory = await repository(t);
  set(directory, 'ai.providers', 'ollama,claude');
  set(directory, 'ai.timeoutSeconds', '40');
  let loaded = await loadAiConfig({}, configReader(directory), 'qq');
  assert.deepEqual(loaded.providers, ['ollama', 'claude']);
  assert.equal(loaded.timeoutSeconds, 40);
  set(directory, 'qq.providers', 'claude');
  set(directory, 'qq.timeoutSeconds', '90');
  loaded = await loadAiConfig({}, configReader(directory), 'qq');
  assert.deepEqual(loaded.providers, ['claude']);
  assert.equal(loaded.timeoutSeconds, 90);
  assert.ok(loaded.origins['qq.providers']);
  // Without a scope the tool keys are ignored.
  assert.deepEqual((await loadAiConfig({}, configReader(directory))).providers, ['ollama', 'claude']);
  // Errors name the key that was actually wrong.
  set(directory, 'qq.providers', 'claude,bogus');
  await assert.rejects(loadAiConfig({}, configReader(directory), 'qq'), /qq\.providers: expected/);
  set(directory, 'qq.providers', 'claude');
  set(directory, 'qq.timeoutSeconds', '0');
  await assert.rejects(loadAiConfig({}, configReader(directory), 'qq'), /qq\.timeoutSeconds: expected an integer/);
});

test('Ollama frames a task: system prompt and chat template unless the prompt is self-contained', async () => {
  const original = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = async (url: any, options: any) => {
    requests.push(options?.body ? JSON.parse(options.body) : undefined);
    const body = String(url).endsWith('/api/tags') ? { models: [{ name: 'local-model' }] }
      : String(url).endsWith('/api/show') ? { model_info: { 'general.architecture': 'fake', 'fake.context_length': 4096 } }
      : { model: 'local-model', done: true, response: 'answer' };
    return new Response(JSON.stringify(body));
  };
  try {
    const settings = config({ models: { ollama: 'local-model' } });
    const chat = createAdapter('ollama', settings, task());
    await chat.probe(signal());
    assert.equal(await chat.generate('the question', signal()), 'answer');
    let payload = requests.at(-1);
    assert.equal(payload.prompt, 'the question');
    assert.equal(payload.system, 'SYSTEM INSTRUCTIONS');
    assert.equal(payload.raw, undefined);
    assert.equal(payload.options.num_predict, 777);
    assert.equal(payload.options.temperature, 0.5);
    const raw = createAdapter('ollama', settings, task({ selfContained: true }));
    await raw.probe(signal());
    await raw.generate('complete prompt', signal());
    payload = requests.at(-1);
    assert.equal(payload.raw, true);
    assert.equal(payload.system, undefined);
  } finally { globalThis.fetch = original; }
});

test('Apple prefixes task instructions unless the prompt is self-contained; messages name the tool', async t => {
  const directory = await repository(t);
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const log = join(directory, 'fm-log');
  await writeFile(join(bin, 'fm'), `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  if (args[0] === 'config') console.log('(none)');
  else if (args[0] === 'models') console.log(process.env.FM_MODE === 'down' ? '✗ system' : '✓ system (AFM model)');
  else if (args[0] === 'count-tokens') console.log('10');
  else if (args[0] === 'respond') { fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(input) + '\\n'); console.log('answer'); }
});
`, { mode: 0o700 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(async () => { process.env.PATH = path; delete process.env.FM_MODE; });
  await createAdapter('apple', config(), task()).generate('the question', signal());
  await createAdapter('apple', config(), task({ selfContained: true })).generate('complete prompt', signal());
  const inputs = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(inputs, ['SYSTEM INSTRUCTIONS\n\nthe question', 'complete prompt']);
  process.env.FM_MODE = 'down';
  await assert.rejects(createAdapter('apple', config(), task()).probe(signal()), /test-tool never accepts terms/);
});
