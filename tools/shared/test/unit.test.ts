import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireCommand, run } from '../src/process.ts';
import { Failure } from '../src/errors.ts';
import { fitWidths, paint, truncate } from '../src/gum.ts';

const signal = () => new AbortController().signal;

test('subprocess deadlines/cancellation terminate descendants and do not interpolate arguments', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shared-test-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const marker = join(directory, 'marker');
  const arg = `$(touch ${marker})`;
  const literal = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', arg]);
  assert.equal(literal.stdout, arg);
  await assert.rejects(access(marker));
  const childScript = join(directory, 'child.cjs');
  await writeFile(
    childScript,
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'leaked'), 600);`,
  );
  const parent = `require('node:child_process').spawn(process.execPath, [${JSON.stringify(childScript)}], {stdio:'ignore'}); setInterval(()=>{}, 1000);`;
  await assert.rejects(run(process.execPath, ['-e', parent], { timeoutMs: 100 }), (e: any) => e.kind === 'timeout');
  await new Promise(resolve => setTimeout(resolve, 700));
  await assert.rejects(access(marker));
  const controller = new AbortController();
  const pending = run(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e: any) => e.kind === 'cancelled');
});

test('requireCommand passes for a working executable and gives the caller guidance otherwise', async () => {
  await requireCommand(process.execPath, 'unused', signal());
  await assert.rejects(
    requireCommand('definitely-not-installed-xyz', 'Install it first.', signal()),
    (e: unknown) => e instanceof Failure && e.kind === 'not-installed' && e.message === 'Install it first.',
  );
});

test('table helpers shrink the widest column and never cut painted cells', () => {
  assert.deepEqual(fitWidths(['A', 'B'], [['x'.repeat(30), 'short']], 30), [18, 5]);
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
  assert.equal(truncate('abc', 5), 'abc');
  const painted = paint('78', 'a long painted cell');
  // Repeated calls must agree: a stateful /g regex here once flipped answers between cells.
  assert.equal(truncate(painted, 5), painted);
  assert.equal(truncate(painted, 5), painted);
  assert.equal(truncate('plain text cell', 5), 'plai…');
});
