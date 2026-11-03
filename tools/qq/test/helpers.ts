import '../../shared/test/git-env.ts';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../shared/src/process.ts';
import type { AiConfig } from '../../shared/src/ai/config.ts';

export const root = fileURLToPath(new URL('../../..', import.meta.url));
export const entry = join(root, 'scripts/bin/qq');
const tty = fileURLToPath(new URL('../../shared/test/pty_driver.py', import.meta.url));

export const config = (overrides: Partial<AiConfig> = {}): AiConfig => ({
  providers: ['apple', 'ollama', 'codex', 'claude'], allowCloud: false, timeoutSeconds: 2, pinned: false,
  endpoint: 'http://127.0.0.1:11434', maxContext: { apple: 4096, ollama: 8192 }, ollamaKeepAlive: '0',
  models: {}, efforts: {}, origins: {}, ...overrides,
});

// A fake Claude Code CLI that answers with FAKE_ANSWER and logs each request.
const fakeClaude = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
if (args[0] === '--help') {
  console.log(['--print', '--output-format', '--include-hook-events', '--no-session-persistence', '--safe-mode', '--restricted', '--tools',
    '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '--setting-sources', '--settings', '--system-prompt',
    '--permission-prompts', '--no-chrome', '--model', '--effort'].join('\\n'));
  process.exit(0);
}
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, input, cwd: process.cwd() }) + '\\n');
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'auth') { console.error('Not logged in SECRET'); process.exit(1); }
  const emit = event => console.log(JSON.stringify(event));
  emit({ type: 'system', subtype: 'init', tools: [], mcp_servers: [], skills: [], slash_commands: [], plugins: [], apiKeySource: 'none' });
  const answer = process.env.FAKE_ANSWER ?? 'Use \`getent group NAME\`.';
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: answer, permission_denials: [] });
});
`;

// A fake gum: input types FAKE_GUM_INPUT (or exits FAKE_GUM_INPUT_CODE); format marks its output.
const fakeGum = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) process.exit(0);
if (args[0] === 'input') {
  if (process.env.FAKE_GUM_INPUT_CODE) process.exit(Number(process.env.FAKE_GUM_INPUT_CODE));
  console.log(process.env.FAKE_GUM_INPUT ?? '');
  process.exit(0);
}
if (args[0] === 'format') { console.log('FORMATTED<' + args[args.indexOf('--') + 1] + '>'); process.exit(0); }
process.exit(2);
`;

export type Fixture = { directory: string; log: string; env: NodeJS.ProcessEnv };

// A private directory with fake claude and gum on PATH and a Git config that
// sends qq to claude. `gitConfig` replaces those settings.
export async function fixture(t: { after: (fn: () => Promise<void>) => void },
  gitConfig = '[ai]\n\tallowCloud = true\n[ai "claude"]\n\tmodel = fake-model\n[qq]\n\tproviders = claude\n'): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'qq-test-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'claude'), fakeClaude, { mode: 0o700 });
  await writeFile(join(bin, 'gum'), fakeGum, { mode: 0o700 });
  await writeFile(join(directory, 'gitconfig'), gitConfig);
  const log = join(directory, 'claude-log');
  return { directory, log, env: { PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: join(directory, 'gitconfig'),
    FAKE_CLAUDE_LOG: log, SHELL: '/bin/zsh', NO_COLOR: '' } };
}

export async function qq(f: Fixture, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string; terminal?: boolean } = {}) {
  const env = { ...process.env, ...f.env, ...options.env };
  if (options.terminal) return await run('python3', [tty, entry, ...args], { cwd: f.directory, env, timeoutMs: 20_000 });
  return await run(entry, args, { cwd: f.directory, env, input: options.input, timeoutMs: 20_000 });
}
