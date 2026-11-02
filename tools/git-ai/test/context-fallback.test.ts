import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { generate } from '../src/fallback.ts';
import { createAdapter } from '../src/providers.ts';
import { Failure } from '../../shared/src/errors.ts';
import { config, fixture, fakeCodex } from './helpers.ts';
import type { Snapshot } from '../src/git.ts';
import type { Adapter } from '../src/providers.ts';
import type { ProviderName } from '../src/config.ts';
import { checkCodexEvents } from '../src/codex.ts';

const snapshot: Snapshot = { tree: 't', history: [], changes: [{ status: 'A', paths: ['file'], oldMode: '000000',
  newMode: '100644', oldObject: '0'.repeat(40), newObject: 'a'.repeat(40), patch: '+staged evidence', partial: false }] };
const signal = () => new AbortController().signal;

function adapters(calls: string[], failures: Partial<Record<ProviderName, string>> = {}): (name: ProviderName) => Adapter {
  return name => ({ name,
    async probe() {
      calls.push(`${name}:probe`);
      return { model: 'explicit-model', locality: name === 'codex' ? 'remote' : 'local', inputBytes: name === 'apple' ? 50 : 6000, detail: '' };
    },
    async generate() {
      calls.push(`${name}:generate`);
      if (failures[name]) throw new Failure('unavailable', failures[name]);
      return 'chore: describe changes';
    },
  });
}

test('oversized Apple-only chain offers Codex once; ask occurs before its probe and request', async () => {
  const calls: string[] = [], reports: string[] = [];
  const result = await generate(snapshot, config({ providers: ['apple'], allowCloud: true, models: { codex: 'explicit-model' } }),
    signal(), line => reports.push(line), adapters(calls), undefined, async (_config, failed) => {
      assert.deepEqual(calls, ['apple:probe']);
      assert.deepEqual(failed, ['apple']);
      calls.push('ask'); return true;
    });
  assert.equal(result, 'chore: describe changes');
  assert.deepEqual(calls, ['apple:probe', 'ask', 'codex:probe', 'codex:generate']);
  assert.ok(reports.some(line => line.includes('offering Codex')));
});

test('auto context fallback reports escalation and never calls confirmation', async () => {
  const calls: string[] = [], reports: string[] = [];
  await generate(snapshot, config({ providers: ['apple'], contextFallback: 'auto', allowCloud: true, models: { codex: 'explicit-model' } }),
    signal(), line => reports.push(line), adapters(calls), undefined, async () => { assert.fail('auto must not ask'); });
  assert.ok(reports.some(line => line.includes('automatically trying Codex')));
  assert.equal(calls.filter(call => call === 'codex:generate').length, 1);
});

test('declining or cancelling stops the operation without contacting Codex', async () => {
  for (const cancel of [false, true]) {
    const calls: string[] = [];
    await assert.rejects(generate(snapshot, config({ providers: ['apple'], allowCloud: true, models: { codex: 'explicit-model' } }),
      signal(), () => {}, adapters(calls), undefined, async () => {
        if (cancel) throw new Failure('cancelled', 'cancelled');
        return false;
      }), (error: any) => error.kind === 'cancelled');
    assert.deepEqual(calls, ['apple:probe']);
  }
});

test('never, pinning, privacy denial and missing model prevent automatic escalation and prompting', async () => {
  for (const overrides of [
    { contextFallback: 'never' as const }, { pinned: true }, { allowCloud: false }, { models: {} },
  ]) {
    const calls: string[] = [];
    await assert.rejects(generate(snapshot, config({ providers: ['apple'], allowCloud: true, models: { codex: 'explicit-model' }, ...overrides }),
      signal(), () => {}, adapters(calls), undefined, async () => { assert.fail('must not ask'); }));
    assert.deepEqual(calls, ['apple:probe']);
  }
});

test('ordinary provider failure does not add Codex, and another local success avoids escalation', async () => {
  const calls: string[] = [];
  await assert.rejects(generate(snapshot, config({ providers: ['ollama'], allowCloud: true, models: { codex: 'model' } }),
    signal(), () => {}, adapters(calls, { ollama: 'offline' }), undefined, async () => { assert.fail('must not ask'); }));
  assert.deepEqual(calls, ['ollama:probe', 'ollama:generate']);
  calls.length = 0;
  assert.equal(await generate(snapshot, config({ providers: ['apple', 'ollama'], allowCloud: true, models: { codex: 'model' } }),
    signal(), () => {}, adapters(calls), undefined, async () => { assert.fail('must not ask'); }), 'chore: describe changes');
  assert.deepEqual(calls, ['apple:probe', 'ollama:probe', 'ollama:generate']);
});

test('configured Codex appears at most once and explicit Codex pin bypasses context prompting', async () => {
  const calls: string[] = [];
  await assert.rejects(generate(snapshot, config({ providers: ['apple', 'codex'], contextFallback: 'auto', allowCloud: true, models: { codex: 'model' } }),
    signal(), () => {}, adapters(calls, { codex: 'offline' })));
  assert.equal(calls.filter(call => call === 'codex:probe').length, 1);
  calls.length = 0;
  await generate(snapshot, config({ providers: ['codex'], pinned: true, contextFallback: 'never', allowCloud: true, models: { codex: 'model' } }),
    signal(), () => {}, adapters(calls), undefined, async () => { assert.fail('must not ask'); });
  assert.deepEqual(calls, ['codex:probe', 'codex:generate']);
});

test('Codex adapter passes only prepared stdin with explicit model/effort and constrained exec flags', async t => {
  const directory = await fixture(t);
  const env = await fakeCodex(directory);
  const before = { PATH: process.env.PATH, FAKE_CODEX_LOG: process.env.FAKE_CODEX_LOG,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY, CODEX_API_KEY: process.env.CODEX_API_KEY, GIT_DIR: process.env.GIT_DIR };
  Object.assign(process.env, env, { OPENAI_API_KEY: 'DUMMY', CODEX_API_KEY: 'DUMMY', GIT_DIR: directory });
  try {
    const model = 'model;$(touch SHOULD-NOT-EXIST)';
    const adapter = createAdapter('codex', config({ allowCloud: true, models: { codex: model }, efforts: { codex: 'low' } }));
    assert.equal((await adapter.probe(signal())).locality, 'remote');
    assert.equal(await adapter.generate('ONLY PREPARED STAGED DATA', signal()), 'chore: describe staged changes');
    const record = JSON.parse((await readFile(env.FAKE_CODEX_LOG!, 'utf8')).trim());
    assert.equal(record.input, 'ONLY PREPARED STAGED DATA');
    assert.ok(!record.cwd.startsWith(directory));
    assert.equal(record.args[record.args.indexOf('--model') + 1], model);
    for (const argument of ['--ignore-user-config', '--ephemeral', '--skip-git-repo-check', 'read-only',
      'approval_policy="never"', 'forced_login_method="chatgpt"', 'web_search="disabled"', 'mcp_servers={}',
      'project_doc_max_bytes=0', 'model_reasoning_effort="low"', 'shell_tool', 'hooks', 'apps', 'plugins', 'multi_agent'])
      assert.ok(record.args.includes(argument), argument);
    assert.equal(record.gitDir, undefined);
    assert.equal(record.apiKeyPresent, false);
    assert.equal(record.codexApiKeyPresent, false);
    assert.equal(record.fileMode, 0o600);
    assert.equal(record.dirMode, 0o700);
    assert.deepEqual(record.files.sort(), ['instructions', 'message']);
    await assert.rejects(access(record.cwd));
  } finally {
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

for (const [mode, kind] of [['auth', 'auth-required'], ['context', 'context-too-large'], ['reasoning', 'configuration-invalid'], ['tool', 'unavailable'], ['error-item', 'auth-required']] as const) {
  test(`Codex ${mode} failure is classified without exposing logs, and temporary input is cleaned`, async t => {
    const directory = await fixture(t);
    const env = await fakeCodex(directory);
    const before = { PATH: process.env.PATH, FAKE_CODEX_LOG: process.env.FAKE_CODEX_LOG, FAKE_CODEX_MODE: process.env.FAKE_CODEX_MODE };
    Object.assign(process.env, env, { FAKE_CODEX_MODE: mode });
    try {
      const adapter = createAdapter('codex', config({ allowCloud: true, models: { codex: 'explicit-model' } }));
      await assert.rejects(adapter.generate('private prepared data', signal()), (error: any) => error.kind === kind && !error.message.includes('SECRET'));
      const record = JSON.parse((await readFile(env.FAKE_CODEX_LOG!, 'utf8')).trim());
      await assert.rejects(access(record.cwd));
    } finally {
      for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test('Codex accepts passive reasoning/plan events without treating them as actions or output', () => {
  const events = [
    { type: 'thread.started' },
    { type: 'item.started', item: { type: 'reasoning', text: 'PRIVATE REASONING' } },
    { type: 'item.updated', item: { type: 'todo_list', items: [{ text: 'PRIVATE PLAN', completed: false }] } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'PRIVATE MESSAGE' } },
    { type: 'turn.completed', usage: {} },
  ];
  assert.deepEqual(checkCodexEvents(events.map(event => JSON.stringify(event)).join('\n')), { error: '', warnings: '', completed: true });
});

test('Codex non-fatal error items do not mask successful completion, but failed/incomplete turns remain failures', () => {
  const warning = { type: 'item.completed', item: { type: 'error', message: 'PRIVATE non-fatal warning' } };
  const events = checkCodexEvents([warning, { type: 'turn.completed' }].map(event => JSON.stringify(event)).join('\n'));
  assert.equal(events.error, '');
  assert.equal(events.completed, true);
  assert.match(events.warnings, /PRIVATE/);
  const failed = checkCodexEvents(JSON.stringify({ type: 'turn.failed', error: { message: 'PRIVATE failure' } }));
  assert.match(failed.error, /PRIVATE failure/);
  assert.equal(failed.completed, false);
  assert.equal(checkCodexEvents(JSON.stringify(warning)).completed, false);
});

test('Codex rejects actual and unknown action types with useful type-only diagnostics', () => {
  for (const type of ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'future_action']) {
    assert.throws(() => checkCodexEvents(JSON.stringify({ type: 'item.started', item: { type, command: 'PRIVATE COMMAND' } })),
      (error: any) => error.kind === 'unavailable' && error.message.includes(type) && !error.message.includes('PRIVATE'));
  }
  for (const data of ['null', '[]', 'bad-json']) assert.throws(() => checkCodexEvents(data));
});
