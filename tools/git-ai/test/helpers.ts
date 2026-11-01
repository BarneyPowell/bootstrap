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
