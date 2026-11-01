import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.ts';
import { loadConfig } from '../src/config.ts';
import { validateMessage } from '../src/validation.ts';
import { prepare, instructions } from '../src/prompt.ts';
import { generate } from '../src/fallback.ts';
import { createAdapter, httpJSON, isLoopback } from '../src/providers.ts';
import { Failure } from '../src/errors.ts';
import { run } from '../src/process.ts';
import { config, fixture, git } from './helpers.ts';
import { writeFile, readFile, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Snapshot } from '../src/git.ts';
import type { Adapter } from '../src/providers.ts';
import { modelChoices } from '../src/ollama-models.ts';
import { codexModels } from '../src/codex-models.ts';
import { claudeModels, claudeModelRequest } from '../src/claude-models.ts';
import { buildModelChoices } from '../src/model-picker.ts';
import { plainLines, nextSteps, wrap } from '../src/doctor.ts';
import type { DoctorReport } from '../src/doctor.ts';

const signal = () => new AbortController().signal;
const snapshot: Snapshot = { tree: 'tree', history: ['chore: historical example'], changes: [{
  paths: ['file.ts'], status: 'M', oldMode: '100644', newMode: '100644', oldObject: 'a'.repeat(40), newObject: 'b'.repeat(40),
  patch: '+staged evidence\n', partial: false,
}] };

test('CLI accepts scoped options and rejects all unsupported Git flags and pathspecs', () => {
  assert.deepEqual(parseArgs(['commit', '--provider', 'codex', '--model', 'id', '--reasoning-effort', 'low', '--dry-run']).options,
    { provider: 'codex', model: 'id', reasoningEffort: 'low', dryRun: true });
  for (const option of ['--no-edit', '-a', '--all', '--amend', '--fixup', '--squash', '--interactive', '--no-verify', '-m', '--message', 'pathspec', '--unknown'])
    assert.throws(() => parseArgs(['commit', option]));
  for (const args of [['other'], ['commit', '--model', 'x'], ['commit', '--reasoning-effort', 'low'], ['commit', '--provider', 'invalid'], ['commit', '--dry-run', '--dry-run'], ['doctor', '--provider', 'apple']])
    assert.throws(() => parseArgs(args));
});

test('model picker arguments default to global and reject ambiguous or unrelated overrides', () => {
  assert.deepEqual(parseArgs(['ollama', 'models']), { command: 'ollama-models', options: {}, scope: 'global' });
  assert.equal(parseArgs(['ollama', 'models', '--local']).scope, 'local');
  assert.equal(parseArgs(['ollama', 'models', '--global']).scope, 'global');
  assert.deepEqual(parseArgs(['codex', 'models']), { command: 'codex-models', options: {}, scope: 'global' });
  assert.equal(parseArgs(['codex', 'models', '--local']).scope, 'local');
  assert.deepEqual(parseArgs(['claude', 'models']), { command: 'claude-models', options: {}, scope: 'global' });
  assert.equal(parseArgs(['claude', 'models', '--local']).scope, 'local');
  assert.throws(() => parseArgs(['claude', 'models', '--provider', 'claude']));
  assert.throws(() => parseArgs(['claude', 'models', '--global', '--local']));
  for (const args of [['ollama'], ['ollama', 'other'], ['ollama', 'models', '--global', '--local'], ['ollama', 'models', '--provider', 'ollama'], ['ollama', 'models', '--dry-run'], ['codex', 'models', '--all'], ['codex', 'models', '--local', '--global']])
    assert.throws(() => parseArgs(args));
});

test('Codex catalog exposes visible identifiers/efforts without instruction templates or guessed defaults', () => {
  assert.deepEqual(codexModels({ models: [
    { slug: 'literal;$(touch BAD)', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }], base_instructions: 'PRIVATE' },
    { slug: 'hidden', visibility: 'hide' },
  ] }), [{ name: 'literal;$(touch BAD)', remote: true, efforts: ['low'] }]);
  for (const data of [{}, { models: [null] }, { models: [{ slug: 'bad\nname', visibility: 'list' }] },
    { models: [{ slug: 'm', visibility: 'list', supported_reasoning_levels: 'low' }] }]) assert.throws(() => codexModels(data));
});

test('Claude initialization exposes resolved IDs, preserves context variants and recognises saved aliases', () => {
  const request = JSON.parse(claudeModelRequest);
  assert.equal(request.type, 'control_request');
  assert.equal(request.request.subtype, 'initialize');
  const envelope = (models: unknown) => JSON.stringify({ type: 'control_response', response: {
    request_id: request.request_id, subtype: 'success', pending_permission_requests: [], response: { models },
  } });
  const models = claudeModels(envelope([
    { value: 'fast', resolvedModel: 'claude-test-fast', supportedEffortLevels: ['low'] },
    { value: 'default', resolvedModel: 'claude-test-largest' },
    { value: 'large', resolvedModel: 'claude-test-largest' },
    { value: 'compact[1m]', resolvedModel: 'claude-test-compact', supportsEffort: false },
    { value: 'inherit' },
  ]));
  assert.equal(models[0].name, 'claude-test-fast');
  assert.ok(models.some(model => model.name === 'claude-test-compact[1m]'));
  assert.ok(!models.some(model => model.name === 'inherit'));
  const choices = buildModelChoices(models, 'large');
  assert.equal(choices.length, 3);
  assert.equal(choices[0].model.name, 'claude-test-largest');
  assert.deepEqual(choices[0].model.aliases, ['default', 'large']);
  assert.match(choices[0].label, /current default/);
  for (const data of ['bad-json', 'null', envelope(null), envelope([{ value: 'bad\nname' }]),
    envelope([{ value: 'good', resolvedModel: '\x1b[31mbad' }]),
    envelope([{ value: 'good', supportedEffortLevels: 'low' }])]) assert.throws(() => claudeModels(data));
});

test('model choices mark and prioritise current selection, deduplicate, and label remote models', () => {
  const choices = modelChoices({ models: [
    { name: 'a-model' }, { name: 'z-model' }, { name: 'a-model', remote_host: 'remote' },
    { model: 'literal;$(touch BAD)' },
  ] }, 'z-model');
  assert.equal(choices.length, 3);
  assert.equal(choices[0].model.name, 'z-model');
  assert.match(choices[0].label, /current default/);
  assert.ok(choices.some(choice => choice.model.name === 'a-model' && choice.model.remote));
  assert.deepEqual(modelChoices({ models: [] }), []);
  assert.ok(modelChoices({ models: [{ name: 'other' }] }, 'missing').every(choice => !choice.label.includes('current default')));
  for (const bad of [{}, { models: null }, { models: [null] }, { models: [{ name: 'bad\nname' }] }, { models: [{ name: '\x1b[31mred' }] }, { models: [{ name: ' ' }] }])
    assert.throws(() => modelChoices(bad));
});

test('Git config defaults, effective includes, CLI overrides and booleans', async t => {
  const directory = await fixture(t);
  assert.deepEqual((await loadConfig({}, directory)).providers, ['apple', 'ollama', 'codex', 'claude']);
  assert.equal((await loadConfig({}, directory)).allowCloud, false);
  assert.equal((await loadConfig({}, directory)).contextFallback, 'ask');
  assert.equal((await loadConfig({ provider: 'apple' }, directory)).pinned, true);
  const included = join(directory, 'included-config');
  await writeFile(included, '[ai]\nallowCloud = yes\nproviders = ollama, apple\n[ai "ollama"]\nmodel = local-id\n');
  git(directory, 'config', 'include.path', included);
  assert.equal((await loadConfig({}, directory)).allowCloud, true);
  const overridden = await loadConfig({ provider: 'ollama', model: 'literal;$(touch bad)' }, directory);
  assert.deepEqual(overridden.providers, ['ollama']);
  assert.equal(overridden.models.ollama, 'literal;$(touch bad)');
  assert.match(overridden.origins['ai.allowCloud'], /included-config/);
  git(directory, 'config', 'ai.allowCloud', 'false');
  assert.equal((await loadConfig({}, directory)).allowCloud, false);
});

test('malformed settings fail with their key and do not silently disappear in fallback', async t => {
  const directory = await fixture(t);
  for (const [key, value] of [
    ['ai.providers', 'apple,apple'], ['ai.providers', 'apple,wat'], ['ai.providers', ''], ['ai.allowCloud', 'maybe'],
    ['ai.timeoutSeconds', '0'], ['ai.timeoutSeconds', '3x'], ['ai.commit.recentCount', '-1'],
    ['ai.commit.subjectMaxLength', '0'], ['ai.ollama.endpoint', 'http://user:secret@localhost'],
    ['ai.apple.model', 'cloud'], ['ai.apple.reasoningEffort', 'low'], ['ai.ollama.reasoningEffort', 'low'],
    ['ai.codex.reasoningEffort', 'turbo'], ['ai.claude.reasoningEffort', 'turbo'], ['ai.codex.model', ''],
    ['ai.commit.contextFallback', 'yes'],
    ['ai.apple.maxContext', '1000'], ['ai.apple.maxContext', '99999'], ['ai.ollama.maxContext', 'big'], ['ai.ollama.maxContext', '1024'],
    ['ai.ollama.keepAlive', 'forever'], ['ai.ollama.keepAlive', '5d'], ['ai.ollama.keepAlive', '-5'], ['ai.ollama.keepAlive', ''],
  ]) {
    git(directory, 'config', key, value);
    await assert.rejects(loadConfig({}, directory), error => error instanceof Failure && error.kind === 'configuration-invalid' && error.message.includes(key));
    git(directory, 'config', '--unset', key);
  }
  git(directory, 'config', 'ai.codex.reasoningEffort', 'low');
  git(directory, 'config', 'ai.claude.reasoningEffort', 'medium');
  const result = await loadConfig({}, directory);
  assert.deepEqual(result.efforts, { codex: 'low', claude: 'medium' });
});

test('local context ceilings and Ollama keep-alive default conservatively and accept explicit values', async t => {
  const directory = await fixture(t);
  const defaults = await loadConfig({}, directory);
  assert.deepEqual(defaults.maxContext, { apple: 4096, ollama: 8192 });
  assert.equal(defaults.ollamaKeepAlive, '0');
  git(directory, 'config', 'ai.apple.maxContext', '6144');
  git(directory, 'config', 'ai.ollama.maxContext', '32768');
  for (const keepAlive of ['-1', '300', '30s', '10m', '1h']) {
    git(directory, 'config', 'ai.ollama.keepAlive', keepAlive);
    const result = await loadConfig({}, directory);
    assert.deepEqual(result.maxContext, { apple: 6144, ollama: 32768 });
    assert.equal(result.ollamaKeepAlive, keepAlive);
  }
});

test('Ollama adapter caps context at ai.ollama.maxContext and forwards keep-alive', async () => {
  const original = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = async (url: any, options: any) => {
    requests.push([String(url), options]);
    const body = String(url).endsWith('/api/tags') ? { models: [{ name: 'big-model' }] }
      : String(url).endsWith('/api/show') ? { model_info: { 'general.architecture': 'fake', 'fake.context_length': 262144 } }
      : { model: 'big-model', done: true, response: 'fix: update behavior' };
    return new Response(JSON.stringify(body));
  };
  try {
    for (const [maxContext, keepAlive, expected] of [[8192, '0', 0], [32768, '-1', -1], [32768, '300', 300], [16384, '10m', '10m']] as const) {
      const adapter = createAdapter('ollama', config({ models: { ollama: 'big-model' }, maxContext: { apple: 4096, ollama: maxContext }, ollamaKeepAlive: keepAlive }));
      assert.equal((await adapter.probe(signal())).inputBytes, maxContext - 1024);
      await adapter.generate('prepared input only', signal());
      const payload = JSON.parse(requests.at(-1)[1].body);
      assert.equal(payload.options.num_ctx, maxContext);
      assert.strictEqual(payload.keep_alive, expected);
    }
    // A model whose own window is smaller than the ceiling is never padded up to it.
    globalThis.fetch = async (url: any) => new Response(JSON.stringify(String(url).endsWith('/api/tags') ? { models: [{ name: 'small' }] }
      : { model_info: { 'general.architecture': 'fake', 'fake.context_length': 4096 } }));
    const small = createAdapter('ollama', config({ models: { ollama: 'small' }, maxContext: { apple: 4096, ollama: 32768 } }));
    assert.equal((await small.probe(signal())).inputBytes, 4096 - 1024);
  } finally { globalThis.fetch = original; }
});

test('Apple budget follows ai.apple.maxContext and an fm context overflow escalates as context-too-large', async t => {
  const directory = await fixture(t);
  const bin = join(directory, 'fake-bin');
  await mkdir(bin);
  await writeFile(join(bin, 'fm'), `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  if (args[0] === 'config') console.log('(none)');
  else if (args[0] === 'models') { console.log('✓ system (AFM model)'); }
  else if (args[0] === 'count-tokens') console.log(process.env.FM_TEST_TOKENS);
  else if (args[0] === 'respond' && process.env.FM_TEST_MODE === 'overflow') { console.error("Error: The session's transcript exceeded the model's context size. SECRET"); process.exitCode = 1; }
  else if (args[0] === 'respond' && process.env.FM_TEST_MODE === 'broken') { console.error('some other failure'); process.exitCode = 1; }
  else if (args[0] === 'respond') console.log('fix: update behavior');
});
`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    process.env.FM_TEST_TOKENS = '5000';
    const conservative = createAdapter('apple', config());
    assert.equal((await conservative.probe(signal())).inputBytes, 4096 - 1024);
    await assert.rejects(conservative.generate('x', signal()), (e: any) => e.kind === 'context-too-large');
    const raised = createAdapter('apple', config({ maxContext: { apple: 6144, ollama: 8192 } }));
    assert.equal((await raised.probe(signal())).inputBytes, 6144 - 1024);
    assert.match(await raised.generate('x', signal()), /fix: update behavior/);
    process.env.FM_TEST_TOKENS = '5200';
    await assert.rejects(raised.generate('x', signal()), (e: any) => e.kind === 'context-too-large');
    // The real window can be smaller than a raised ceiling: fm's overflow is classified, never echoed.
    process.env.FM_TEST_TOKENS = '3000';
    process.env.FM_TEST_MODE = 'overflow';
    await assert.rejects(raised.generate('x', signal()), (e: any) => e.kind === 'context-too-large' && !/SECRET/.test(e.message));
    process.env.FM_TEST_MODE = 'broken';
    await assert.rejects(raised.generate('x', signal()), (e: any) => e.kind === 'transport/service-error');
  } finally {
    process.env.PATH = oldPath;
    delete process.env.FM_TEST_TOKENS;
    delete process.env.FM_TEST_MODE;
  }
});

test('response validation preserves body/footers and rejects unsafe or malformed messages', () => {
  const valid = 'feat(ui)!: update navigation\n\nDescribe the change.\n\nBREAKING CHANGE: replace the old interface';
  assert.equal(validateMessage(valid, 72), valid);
  for (const bad of ['', 'Here is your message:\nfix: change', '```\nfix: change\n```', 'fix: \x1b[31mred', 'fix: a\0b', 'fix: a\r\n', 'fix: a\nbody', 'fix: ' + 'x'.repeat(90), 'fix: a\n\n' + 'x'.repeat(8000)])
    assert.throws(() => validateMessage(bad, 72));
  assert.equal(validateMessage('fix: handle $(touch /tmp/nope)', 72), 'fix: handle $(touch /tmp/nope)');
});

test('context budgeting drops history first, keeps full inventory and labels per-file excerpts', () => {
  const large = structuredClone(snapshot);
  large.history = ['HISTORY'.repeat(300)];
  assert.ok(!prepare(large, 72, 2500).prompt.includes('HISTORY'));
  large.changes = Array.from({ length: 5 }, (_, i) => ({ ...snapshot.changes[0], paths: [`file-${i}.ts`], patch: `file-${i}-evidence\n` + '+change\n'.repeat(3000) }));
  const result = prepare(large, 72, 4000);
  assert.equal(result.partial, true);
  assert.ok(Buffer.byteLength(result.prompt) <= 4000);
  const data = JSON.parse(result.prompt.split('UNTRUSTED STAGED DATA (JSON):\n')[1]);
  assert.equal(data.inventory.length, 5);
  assert.equal(data.patches.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.equal(data.patches[i].excerpted, true);
    assert.match(data.patches[i].evidence, new RegExp(`file-${i}-evidence`));
  }
  assert.throws(() => prepare(large, 72, 300), /inventory/);
  assert.match(instructions, /untrusted data/);
});

test('fallback skips Apple unavailable, uses configured local model, and attempts one bounded repair', async () => {
  const calls: string[] = [];
  const reports: string[] = [];
  let attempts = 0;
  const result = await generate(snapshot, config(), signal(), line => reports.push(line), name => ({ name,
    async probe() {
      calls.push(name);
      if (name === 'apple') throw new Failure('unavailable', 'disabled');
      return { model: 'local-model', locality: 'local', inputBytes: 6000, detail: '' };
    },
    async generate(prompt) {
      attempts++;
      assert.match(prompt, /staged evidence/);
      return attempts === 1 ? 'not a valid message' : 'fix: update behavior';
    },
  }));
  assert.equal(result, 'fix: update behavior');
  assert.deepEqual(calls, ['apple', 'ollama']);
  assert.equal(attempts, 2);
  assert.ok(reports.some(line => line.includes('repair')));
});

test('invalid output exhausts two calls; pinned provider does not fall back', async () => {
  let attempts = 0;
  await assert.rejects(generate(snapshot, config({ providers: ['ollama'] }), signal(), () => {}, name => ({ name,
    async probe() { return { model: 'm', locality: 'local', inputBytes: 6000, detail: '' }; },
    async generate() { attempts++; return 'bad'; },
  })), /No provider/);
  assert.equal(attempts, 2);
});

test('too-small context falls back and global config/cancellation failures stop immediately', async () => {
  const called: string[] = [];
  const factory = (kind: 'configuration-invalid' | 'cancelled' | undefined) => (name: any): Adapter => ({ name,
    async probe() {
      called.push(name);
      if (kind) throw new Failure(kind, 'stop');
      return { model: 'm', locality: 'local', inputBytes: name === 'apple' ? 20 : 6000, detail: '' };
    },
    async generate() { return 'chore: update files'; },
  });
  assert.equal(await generate(snapshot, config(), signal(), () => {}, factory(undefined)), 'chore: update files');
  assert.deepEqual(called, ['apple', 'ollama']);
  for (const kind of ['configuration-invalid', 'cancelled'] as const) {
    called.length = 0;
    await assert.rejects(generate(snapshot, config(), signal(), () => {}, factory(kind)), /stop/);
    assert.deepEqual(called, ['apple']);
  }
});

test('cloud policy blocks pinned remote CLIs and Ollama before any HTTP request', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw Error('must not be called'); };
  try {
    for (const name of ['codex', 'claude', 'ollama'] as const) {
      const adapter = createAdapter(name, config({ models: { [name]: 'model' }, endpoint: 'https://remote.example.invalid' }));
      await assert.rejects(adapter.probe(signal()), (error: any) => error.kind === 'privacy-blocked');
    }
    assert.equal(requests, 0);
    for (const host of ['http://127.0.0.1:11434', 'http://127.0.0.2:11434', 'http://localhost:11434', 'http://[::1]:11434']) assert.equal(isLoopback(host), true);
    assert.equal(isLoopback('http://localhost.example.invalid'), false);
    assert.equal(isLoopback('http://127.attacker.example.invalid'), false);
  } finally { globalThis.fetch = original; }
});

test('Ollama adapter verifies exact model, context and request options; refuses reported remote models', async () => {
  const original = globalThis.fetch;
  const requests: any[] = [];
  let remote = false;
  globalThis.fetch = async (url: any, options: any) => {
    requests.push([String(url), options]);
    assert.equal(options.redirect, 'error');
    const body = String(url).endsWith('/api/tags') ? { models: [{ name: 'model;literal', ...(remote ? { remote_host: 'remote' } : {}) }] }
      : String(url).endsWith('/api/show') ? { model_info: { 'general.architecture': 'fake', 'fake.context_length': 8192 } }
      : { model: 'model;literal', done: true, response: 'fix: update behavior' };
    return new Response(JSON.stringify(body));
  };
  try {
    const adapter = createAdapter('ollama', config({ models: { ollama: 'model;literal' } }));
    assert.equal((await adapter.probe(signal())).locality, 'local');
    assert.equal(await adapter.generate('prepared input only', signal()), 'fix: update behavior');
    const payload = JSON.parse(requests.at(-1)[1].body);
    assert.equal(payload.model, 'model;literal');
    assert.equal(payload.raw, true);
    assert.equal(payload.keep_alive, 0);
    assert.equal(payload.options.num_ctx, 8192);
    assert.equal(payload.options.num_predict, 512);
    remote = true;
    await assert.rejects(adapter.probe(signal()), (e: any) => e.kind === 'privacy-blocked');
  } finally { globalThis.fetch = original; }
});

test('Ollama HTTP failures are structured and never disclose raw logs', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, kind] of [[401, 'auth-required'], [429, 'transport/service-error'], [500, 'transport/service-error']] as const) {
      globalThis.fetch = async () => new Response('SECRET-PROMPT', { status });
      await assert.rejects(httpJSON('http://localhost', '/api/tags', undefined, signal()), (e: any) => e.kind === kind && !e.message.includes('SECRET'));
    }
    globalThis.fetch = async () => { throw Error('SECRET'); };
    await assert.rejects(httpJSON('http://localhost', '/api/tags', undefined, signal()), /connection failed/);
  } finally { globalThis.fetch = original; }
});

test('unconfigured providers give actionable errors', async () => {
  await assert.rejects(createAdapter('ollama', config()).probe(signal()), (e: any) => e.kind === 'model-not-configured');
});

const fakeClaudeSource = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = process.env.CLAUDE_TEST_MODE || 'ok';
if (args[0] === '--help') {
  const flags = ['--print', '--output-format', '--include-hook-events', '--no-session-persistence', '--safe-mode', '--restricted', '--tools',
    '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '--setting-sources', '--settings', '--system-prompt',
    '--permission-prompts', '--no-chrome', '--model', '--effort'];
  console.log(flags.filter(flag => mode !== 'oldcli' || flag !== '--safe-mode').join('\\n'));
  process.exit(0);
}
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.CLAUDE_TEST_LOG, JSON.stringify({ args, input, cwd: process.cwd(),
    hasApiKey: 'ANTHROPIC_API_KEY' in process.env, gitDir: process.env.GIT_DIR }) + '\\n');
  const emit = event => console.log(JSON.stringify(event));
  const init = { type: 'system', subtype: 'init', tools: [], mcp_servers: [], skills: [], slash_commands: [], plugins: [{ path: 'builtin' }], apiKeySource: 'none' };
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'fix: update behavior', permission_denials: [] };
  if (mode === 'badjson') { console.log('PRIVATE NOT JSON'); return; }
  if (mode === 'tools') init.tools = ['Bash'];
  if (mode === 'mcp') init.mcp_servers = [{ name: 'x' }];
  if (mode === 'plugin') init.plugins = [{ path: '/home/user/plugin' }];
  if (mode === 'apikey') init.apiKeySource = 'ANTHROPIC_API_KEY';
  if (mode !== 'noinit') emit(init);
  if (mode === 'hook') emit({ type: 'system', subtype: 'hook_started' });
  if (mode === 'user') emit({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
  emit({ type: 'rate_limit_event', rate_limit_info: {} });
  emit({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'ok' }, mode === 'tooluse' ? { type: 'tool_use', name: 'Bash' } : mode === 'weird' ? { type: 'surprise' } : { type: 'text', text: 'fix: update behavior' }] } });
  if (mode === 'denied') result.permission_denials = [{ tool_name: 'Bash' }];
  if (mode === 'auth') Object.assign(result, { is_error: true, result: 'PRIVATE Not logged in · Please run /login' });
  if (mode === 'context') Object.assign(result, { is_error: true, result: 'PRIVATE Prompt is too long' });
  if (mode === 'model') Object.assign(result, { is_error: true, result: 'PRIVATE There is an issue with the selected model' });
  if (mode === 'other') Object.assign(result, { is_error: true, result: 'PRIVATE boom' });
  emit(result);
  if (result.is_error) { console.error('PRIVATE STDERR'); process.exitCode = 1; }
});
`;

async function claudeFixture(t: any) {
  const directory = await fixture(t);
  const bin = join(directory, 'fake-bin');
  await mkdir(bin);
  await writeFile(join(bin, 'claude'), fakeClaudeSource, { mode: 0o700 });
  const saved = { path: process.env.PATH, key: process.env.ANTHROPIC_API_KEY, gitDir: process.env.GIT_DIR };
  process.env.PATH = `${bin}:${saved.path}`;
  process.env.CLAUDE_TEST_LOG = join(directory, 'claude-log');
  process.env.ANTHROPIC_API_KEY = 'SECRET-KEY';
  process.env.GIT_DIR = '/nonexistent/git-dir';
  t.after(() => {
    process.env.PATH = saved.path;
    for (const [name, value] of [['ANTHROPIC_API_KEY', saved.key], ['GIT_DIR', saved.gitDir]] as const)
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    delete process.env.CLAUDE_TEST_LOG;
    delete process.env.CLAUDE_TEST_MODE;
  });
  return { directory, log: process.env.CLAUDE_TEST_LOG };
}

test('Claude adapter probes required controls without sending content and generates under the requested constraints', async t => {
  const { directory, log } = await claudeFixture(t);
  const adapter = createAdapter('claude', config({ allowCloud: true, models: { claude: 'explicit-model' }, efforts: { claude: 'low' } }));
  const capabilities = await adapter.probe(signal());
  assert.equal(capabilities.locality, 'remote');
  await assert.rejects(readFile(log, 'utf8'), { code: 'ENOENT' });
  assert.equal(await adapter.generate('prepared input only', signal()), 'fix: update behavior');
  const record = JSON.parse((await readFile(log, 'utf8')).trim());
  const joined = record.args.join(' ');
  for (const expected of ['--print', '--safe-mode', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--include-hook-events',
    '--disable-slash-commands', '--no-chrome', '--permission-prompts none', '--model=explicit-model', '--effort=low', '--setting-sources  --settings {"disableAllHooks":true}'])
    assert.ok(joined.includes(expected), expected);
  assert.equal(record.args[record.args.indexOf('--tools') + 1], '');
  assert.equal(record.args[record.args.indexOf('--system-prompt') + 1], instructions);
  assert.equal(record.input, 'prepared input only');
  assert.equal(record.hasApiKey, false);
  assert.equal(record.gitDir, undefined);
  assert.ok(!record.cwd.startsWith(directory));
  await assert.rejects(access(record.cwd));
  // No effort configured: the flag is not sent.
  const plain = createAdapter('claude', config({ allowCloud: true, models: { claude: 'explicit-model' } }));
  await plain.generate('x', signal());
  assert.ok(!JSON.parse((await readFile(log, 'utf8')).trim().split('\n').at(-1)!).args.join(' ').includes('--effort'));
  // Policy and model are enforced before any CLI runs.
  await assert.rejects(createAdapter('claude', config({ models: { claude: 'm' } })).generate('x', signal()), (e: any) => e.kind === 'privacy-blocked');
  await assert.rejects(createAdapter('claude', config({ allowCloud: true })).generate('x', signal()), (e: any) => e.kind === 'model-not-configured');
  process.env.CLAUDE_TEST_MODE = 'oldcli';
  await assert.rejects(createAdapter('claude', config({ allowCloud: true, models: { claude: 'm' } })).probe(signal()), /lacks required controls/);
});

test('Claude adapter refuses results whose session, events or credentials violate the requested constraints', async t => {
  const { log } = await claudeFixture(t);
  for (const [mode, kind, pattern] of [
    ['tools', 'unavailable', /constraints \(tools\)/], ['mcp', 'unavailable', /MCP servers/], ['plugin', 'unavailable', /plugins/],
    ['apikey', 'unavailable', /API-key or token source/], ['noinit', 'unavailable', /did not report its session constraints/],
    ['hook', 'unavailable', /hook event/], ['user', 'unavailable', /tool exchange/], ['tooluse', 'unavailable', /tool_use action/],
    ['weird', 'unavailable', /unsupported content type \(surprise\)/], ['denied', 'unavailable', /denied permissions/],
    ['badjson', 'transport/service-error', /invalid JSON/],
    ['auth', 'auth-required', /claude login/], ['context', 'context-too-large', /too large/], ['model', 'configuration-invalid', /ai\.claude\.model/],
    ['other', 'transport/service-error', /raw logs suppressed/],
  ] as const) {
    process.env.CLAUDE_TEST_MODE = mode;
    const adapter = createAdapter('claude', config({ allowCloud: true, models: { claude: 'm' } }));
    await assert.rejects(adapter.generate('x', signal()), (e: any) => e.kind === kind && pattern.test(e.message) && !/PRIVATE|SECRET/.test(e.message), mode);
  }
  assert.ok((await readFile(log, 'utf8')).trim().split('\n').length >= 15);
});

test('Apple fm adapter pins system, counts stdin tokens, separates stdout, and cleans private directories', async t => {
  const directory = await fixture(t);
  const bin = join(directory, 'fake-bin');
  await mkdir(bin);
  const log = join(directory, 'fm-log');
  const executable = join(bin, 'fm');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  fs.appendFileSync(process.env.FM_TEST_LOG, JSON.stringify({args, input, cwd:process.cwd()}) + '\\n');
  if (args[0] === 'config') console.log(process.env.FM_TEST_MODE === 'custom' ? 'custom-remote' : '(none)');
  else if (args[0] === 'models') { console.log(process.env.FM_TEST_MODE === 'unavailable' ? '✗ system (disabled)' : '✓ system (AFM model)\\n✗ pcc (unavailable)'); process.exitCode = 1; }
  else if (args[0] === 'count-tokens') console.log(process.env.FM_TEST_MODE === 'large' ? '9000' : '500');
  else if (args[0] === 'respond') { console.log('fix: handle literal $(touch BAD)'); console.error('SECRET-PROVIDER-LOG'); }
});
`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.FM_TEST_LOG = log;
  try {
    const adapter = createAdapter('apple', config());
    assert.equal((await adapter.probe(signal())).locality, 'local');
    assert.equal(await adapter.generate('bounded staged input', signal()), 'fix: handle literal $(touch BAD)\n');
    const records = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const response = records.find(r => r.args[0] === 'respond');
    assert.deepEqual(response.args, ['respond', '--model', 'system', '--use-case', 'general', '--guardrails', 'default', '--no-stream', '--greedy']);
    assert.equal(response.input, 'bounded staged input');
    assert.equal(records.find(r => r.args[0] === 'count-tokens').input, 'bounded staged input');
    for (const record of records) {
      assert.ok(!record.cwd.startsWith(directory));
      await assert.rejects(access(record.cwd));
    }
    process.env.FM_TEST_MODE = 'custom';
    await assert.rejects(adapter.generate('DO NOT TRANSMIT', signal()), /custom provider/);
    process.env.FM_TEST_MODE = 'unavailable';
    await assert.rejects(adapter.probe(signal()), /unavailable/);
    process.env.FM_TEST_MODE = 'large';
    await assert.rejects(adapter.generate('oversized', signal()), (e: any) => e.kind === 'context-too-large');
    process.env.PATH = bin + '/missing';
    await assert.rejects(adapter.probe(signal()), (e: any) => e.kind === 'not-installed');
  } finally {
    process.env.PATH = oldPath;
    delete process.env.FM_TEST_LOG;
    delete process.env.FM_TEST_MODE;
  }
});

test('pinned unconfigured model is a configuration error', async t => {
  const directory = await fixture(t);
  await assert.rejects(loadConfig({ provider: 'ollama' }, directory), (e: any) => e.kind === 'configuration-invalid' && /ai.ollama.model/.test(e.message));
});

test('subprocess deadlines/cancellation terminate descendants and do not interpolate arguments', async t => {
  const directory = await fixture(t);
  const marker = join(directory, 'marker');
  const arg = `$(touch ${marker})`;
  const literal = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', arg]);
  assert.equal(literal.stdout, arg);
  await assert.rejects(access(marker));
  const childScript = join(directory, 'child.cjs');
  await writeFile(childScript, `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'leaked'), 600);`);
  const parent = `require('node:child_process').spawn(process.execPath, [${JSON.stringify(childScript)}], {stdio:'ignore'}); setInterval(()=>{}, 1000);`;
  await assert.rejects(run(process.execPath, ['-e', parent], { timeoutMs: 100 }), (e: any) => e.kind === 'timeout');
  await new Promise(resolve => setTimeout(resolve, 700));
  await assert.rejects(access(marker));
  const controller = new AbortController();
  const pending = run(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e: any) => e.kind === 'cancelled');
});

test('provider generation and repair share one deadline', async () => {
  let calls = 0;
  await assert.rejects(generate(snapshot, config({ providers: ['ollama'], timeoutSeconds: 0.06 }), signal(), () => {}, name => ({ name,
    async probe() { return { model: 'm', locality: 'local', inputBytes: 6000, detail: '' }; },
    async generate(_prompt, providerSignal) {
      calls++;
      await run(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], { signal: providerSignal });
      return 'invalid';
    },
  })), /deadline/);
  assert.equal(calls, 1);
});

test('doctor accepts only --plain and the plain report keeps the established one-fact-per-line format', () => {
  assert.deepEqual(parseArgs(['doctor']), { command: 'doctor', options: {} });
  assert.deepEqual(parseArgs(['doctor', '--plain']), { command: 'doctor', options: { plain: true } });
  for (const bad of [['doctor', '--json'], ['doctor', '--plain', '--plain'], ['doctor', 'extra']]) assert.throws(() => parseArgs(bad), /Usage: git ai doctor/);
  const report: DoctorReport = { os: 'testos 1', node: 'v0', cloud: false, order: ['apple', 'claude'], timeoutSeconds: 30, contextFallback: 'ask', recentCount: 8,
    origins: [['ai.allowCloud', 'file:/x/.gitconfig']], entries: [
      { name: 'apple', model: 'system', effort: '(not set)', status: 'ready', locality: 'local', label: '', detail: 'fm ok' },
      { name: 'claude', model: 'm', effort: 'low', status: 'blocked', label: 'privacy-blocked', detail: 'needs cloud', version: '2.1 (Claude Code)' },
      { name: 'codex', model: '(not configured)', effort: '(not set)', status: 'not-configured', label: 'model-not-configured', detail: 'set a model', version: null },
      { name: 'ollama', model: 'x', effort: '(not set)', status: 'unavailable', label: 'timeout', detail: 'slow' }] };
  assert.deepEqual(plainLines(report), [
    'OS=testos 1; Node=v0; cloud=blocked', 'provider order=apple -> claude; deadline=30s per provider',
    'context fallback=ask; ai.allowCloud remains the cloud gate', 'ai.allowCloud origin=file:/x/.gitconfig',
    'apple: model=system; reasoning=(not set)', 'apple: local; fm ok',
    'claude: model=m; reasoning=low', 'claude: executable version=2.1 (Claude Code); authentication and model access unverified', 'claude: privacy-blocked: needs cloud',
    'codex: model=(not configured); reasoning=(not set)', 'codex: executable version unavailable', 'codex: model-not-configured: set a model',
    'ollama: model=x; reasoning=(not set)', 'ollama: timeout: slow']);
  const steps = nextSteps(report);
  assert.equal(steps.length, 3);
  assert.match(steps[0], /^claude: .*ai\.allowCloud true/);
  assert.match(steps[1], /^codex: .*git ai codex models/);
  assert.match(steps[2], /^ollama: timed out/);
  assert.deepEqual(nextSteps({ ...report, entries: [report.entries[0]] }), []);
});

test('doctor wrapping keeps a hanging indent and never exceeds the width', () => {
  assert.equal(wrap('aaa bbb ccc', 9, '• ', '  '), '• aaa bbb\n  ccc');
  const long = wrap('word '.repeat(40).trim(), 30, '• ', '  ');
  for (const line of long.split('\n')) assert.ok([...line].length <= 30, line);
  assert.ok(long.split('\n').slice(1).every(line => line.startsWith('  ')));
  assert.equal(wrap('', 20, '• ', '  '), '• ');
});
