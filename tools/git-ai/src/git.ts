import { lstat } from 'node:fs/promises';
import { run } from './process.ts';
import type { RunOptions, Result } from './process.ts';
import { Failure } from './errors.ts';

export type Change = {
  status: string; paths: string[]; oldMode: string; newMode: string;
  oldObject: string; newObject: string; patch: string; partial: boolean;
  kind?: 'text' | 'binary' | 'symlink' | 'submodule';
};
export type Snapshot = { tree: string; changes: Change[]; history: string[] };

export class Git {
  cwd: string;
  signal?: AbortSignal;
  constructor(cwd = process.cwd(), signal?: AbortSignal) { this.cwd = cwd; this.signal = signal; }
  async capture(args: string[], options: RunOptions = {}): Promise<Result> {
    return await run('git', ['--no-pager', '-c', 'color.ui=false', '-c', 'core.quotePath=true', '-c', 'core.fsmonitor=false', ...args], {
      cwd: this.cwd, signal: this.signal,
      env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' },
      ...options,
    });
  }
  async text(args: string[], options: RunOptions = {}): Promise<string> {
    const result = await this.capture(args, options);
    if (result.code !== 0) throw new Failure('git-error', `Git ${args[0]} failed while reading staged changes. Check repository/index state.`);
    return result.stdout.replace(/\n$/, '');
  }
  async validate(): Promise<void> {
    if ((await this.capture(['rev-parse', '--is-inside-work-tree'])).stdout.trim() !== 'true')
      throw new Failure('git-error', 'Run git ai commit inside a non-bare working-tree repository.');
    this.cwd = await this.text(['rev-parse', '--show-toplevel']);
    if ((await this.text(['ls-files', '--unmerged', '-z'])).length)
      throw new Failure('git-error', 'Resolve unmerged index entries before using git ai commit.');
    for (const state of ['MERGE_HEAD', 'rebase-apply', 'rebase-merge', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer']) {
      const path = await this.text(['rev-parse', '--path-format=absolute', '--git-path', state]);
      try { await lstat(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Failure('git-error', 'Unable to check active Git operation state.');
      }
      throw new Failure('git-error', `Active ${state} operation: finish or abort it using normal Git commands first.`);
    }
  }
  async tree(): Promise<string> { return await this.text(['write-tree']); }
  async assertTree(tree: string): Promise<void> {
    if (await this.tree() !== tree) throw new Failure('git-error', 'The staged index changed. Review the staged changes and rerun git ai commit.');
  }
  async validateCleanup(message: string): Promise<void> {
    // Ask this Git version to apply its effective commentChar/commentString.
    const cleaned = await this.capture(['stripspace', '--strip-comments'], { input: message + '\n' });
    if (cleaned.code !== 0) throw new Failure('configuration-invalid', 'Git cannot apply commit cleanup; check core.commentChar/core.commentString.');
    if (cleaned.stdout.trim() !== message.trim())
      throw new Failure('invalid-output', 'Git comment cleanup would change the message. Avoid lines beginning with the configured Git comment prefix.');
  }
  async collect(recentCount: number): Promise<Snapshot> {
    await this.validate();
    const tree = await this.tree();
    const flags = ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty', '--submodule=short', '--find-renames'];
    const raw = await this.text([...flags, '--raw', '--no-abbrev', '-z', '--']);
    if (!raw) throw new Failure('git-error', 'No staged changes. Stage changes before running git ai commit.');
    const fields = raw.split('\0');
    const changes: Change[] = [];
    for (let i = 0; i < fields.length && fields[i];) {
      const match = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z]\d*)$/.exec(fields[i++]);
      if (!match) throw new Failure('git-error', 'Unexpected Git raw diff metadata.');
      const [, oldMode, newMode, oldObject, newObject, status] = match;
      const paths = [fields[i++]];
      if (/^[RC]/.test(status)) paths.push(fields[i++]);
      // Metadata is complete; text is bounded per file before provider budgeting.
      // Git itself renders binary markers and symlink/submodule metadata; never cat blobs.
      const patch = await this.capture([...flags, '--patch', '--unified=3', '--', ...paths], { limit: 32_768, excerpt: true });
      if (patch.code !== 0 && !patch.truncated) throw new Failure('git-error', 'Unable to read a staged patch.');
      const modes = [oldMode, newMode];
      const kind = modes.includes('160000') ? 'submodule' : modes.includes('120000') ? 'symlink' : /^Binary files /m.test(patch.stdout) ? 'binary' : 'text';
      changes.push({ status, paths, oldMode, newMode, oldObject, newObject, kind,
        patch: patch.stdout, partial: patch.truncated });
    }
    let history: string[] = [];
    if (recentCount && (await this.capture(['rev-parse', '--verify', 'HEAD'])).code === 0) {
      const result = await this.text(['-c', 'log.showSignature=false', 'log', '-z', `-n${recentCount}`, '--format=%s']);
      history = result.split('\0').filter(Boolean).map(subject => subject.slice(0, 200));
    }
    await this.assertTree(tree);
    return { tree, changes, history };
  }
}
