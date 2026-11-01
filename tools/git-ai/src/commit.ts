import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Git } from './git.ts';
import { cancelled } from './errors.ts';

export async function commit(git: Git, tree: string, message: string): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), 'git-ai-message-'));
  try {
    const file = join(directory, 'message');
    await writeFile(file, message + '\n', { mode: 0o600 });
    await git.validate(); // an operation may have started while generating
    await git.assertTree(tree);
    cancelled(git.signal);
    // After handoff, Git owns signals, terminal interaction, hooks and recovery.
    return await new Promise((resolve, reject) => {
      const child = spawn('git', ['commit', '--file', file, '--edit', '--cleanup=strip'], {
        cwd: git.cwd, stdio: 'inherit', shell: false,
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)));
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
