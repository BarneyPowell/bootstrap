import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Config } from '../src/config.ts';

// Each test file runs in its own Node process. Never consult the real Git config.
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';
process.env.GIT_CONFIG_COUNT = '0';
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_PARAMETERS', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[key];

export const config = (overrides: Partial<Config> = {}): Config => ({
  providers: ['apple', 'ollama', 'codex', 'claude'], allowCloud: false, timeoutSeconds: 2,
  contextFallback: 'ask', pinned: false,
  recentCount: 8, subjectMaxLength: 72, endpoint: 'http://127.0.0.1:11434', models: {}, efforts: {}, origins: {}, ...overrides,
});

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '');
}

export async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'git-ai-test-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  git(directory, 'init', '-q');
  git(directory, 'config', 'user.name', 'Test User');
  git(directory, 'config', 'user.email', 'test@example.invalid');
  git(directory, 'config', 'commit.gpgSign', 'false');
  git(directory, 'config', 'core.hooksPath', join(directory, 'hooks'));
  return directory;
}

export async function stage(directory: string, name = 'file.txt', content = 'staged evidence\n'): Promise<void> {
  await mkdir(join(directory, name, '..'), { recursive: true });
  await writeFile(join(directory, name), content);
  git(directory, 'add', '--', name);
}

export async function fakeCodex(directory: string): Promise<NodeJS.ProcessEnv> {
  const bin = join(directory, 'codex-bin');
  await mkdir(bin);
  await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.166.0'); process.exit(0); }
if (args.includes('--help')) {
  console.log('--ignore-user-config --ephemeral --skip-git-repo-check --output-last-message --sandbox --json'); process.exit(0);
}
if (args[0] === 'features') {
  for (const feature of ['shell_tool','hooks','apps','plugins','multi_agent','memories','shell_snapshot','view_image']) console.log(feature + ' stable true');
  process.exit(0);
}
if (args[0] === 'debug' && args[1] === 'models') {
  if (process.env.FAKE_CATALOG_LOG) fs.writeFileSync(process.env.FAKE_CATALOG_LOG, JSON.stringify({args,cwd:process.cwd(),apiKeyPresent:!!process.env.OPENAI_API_KEY}));
  if (process.env.FAKE_CATALOG_MODE === 'error') { console.error('PRIVATE CATALOG LOG'); process.exit(2); }
  if (process.env.FAKE_CATALOG_MODE === 'invalid') { console.log('PRIVATE INVALID CATALOG'); process.exit(0); }
  if (process.env.FAKE_CATALOG_MODE === 'timeout') { setInterval(()=>{},1000); return; }
  console.log(JSON.stringify({models: process.env.FAKE_CATALOG_MODE === 'empty' ? [] : [
    {slug:'model-a',visibility:'list',supported_reasoning_levels:[{effort:'low'}]},
    {slug:'model-z',visibility:'list',supported_reasoning_levels:[{effort:'high'}]},
    {slug:'hidden-model',visibility:'hide',base_instructions:'DO NOT PRINT PRIVATE MODEL INSTRUCTIONS'}
  ]}));
  process.exit(0);
}
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const output = args[args.indexOf('--output-last-message') + 1];
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({args,input,cwd:process.cwd(),
    gitDir:process.env.GIT_DIR, apiKeyPresent:!!process.env.OPENAI_API_KEY, codexApiKeyPresent:!!process.env.CODEX_API_KEY,
    fileMode:fs.statSync(output).mode & 511, dirMode:fs.statSync(process.cwd()).mode & 511,
    files:fs.readdirSync(process.cwd())}) + '\\n');
  const mode = process.env.FAKE_CODEX_MODE;
  if (mode === 'auth') { console.error('not logged in SECRET-PROVIDER-LOG'); process.exit(1); }
  if (mode === 'context') { console.error('maximum context window exceeded SECRET-PROVIDER-LOG'); process.exit(1); }
  if (mode === 'reasoning') { console.error('reasoning effort is unsupported SECRET-PROVIDER-LOG'); process.exit(1); }
  if (mode === 'timeout') { setInterval(() => {}, 1000); return; }
  fs.writeFileSync(output, mode === 'invalid' ? 'not a commit message' : 'chore: describe staged changes');
  if (mode === 'tool') console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution'}}));
  else if (mode === 'plan') {
    console.log(JSON.stringify({type:'item.started',item:{type:'todo_list',items:[{text:'PRIVATE PLAN TEXT',completed:false}]}}));
    console.log(JSON.stringify({type:'item.updated',item:{type:'todo_list',items:[{text:'PRIVATE PLAN TEXT',completed:true}]}}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'PROTOCOL TEXT MUST NOT BE THE RESULT'}}));
  }
  else if (mode === 'error-item') {
    console.log(JSON.stringify({type:'item.completed',item:{type:'error',message:'not logged in SECRET-PROVIDER-LOG'}}));
    process.exitCode=1;
  }
  else if (mode === 'warning') {
    console.log(JSON.stringify({type:'item.completed',item:{type:'error',message:'code_mode_host feature disabled PRIVATE WARNING'}}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'PROTOCOL TEXT MUST NOT BE THE RESULT'}}));
  }
  else console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'PROTOCOL TEXT MUST NOT BE THE RESULT'}}));
  if (mode !== 'incomplete') console.log(JSON.stringify({type:'turn.completed',usage:{}}));
});
`, { mode: 0o700 });
  return { PATH: `${bin}:${process.env.PATH}`, FAKE_CODEX_LOG: join(directory, 'codex-log') };
}
