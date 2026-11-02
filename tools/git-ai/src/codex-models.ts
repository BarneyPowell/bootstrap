import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { Failure } from '../../shared/src/errors.ts';
import { run } from '../../shared/src/process.ts';
import { codexEnvironment } from './codex.ts';
import { pickerDependency, selectModel, validModelName } from './model-picker.ts';
import type { PickerModel } from './model-picker.ts';

export function codexModels(data: unknown): PickerModel[] {
  if (!data || !Array.isArray((data as any).models))
    throw new Failure('transport/service-error', 'Codex returned an invalid model catalog. Update/check the installed CLI; no setting was changed.');
  const result: PickerModel[] = [];
  for (const entry of (data as any).models) {
    if (!entry || typeof entry !== 'object') throw new Failure('transport/service-error', 'Codex returned an invalid model catalog entry.');
    if (entry.visibility !== 'list') continue;
    if (!validModelName(entry.slug)) throw new Failure('transport/service-error', 'Codex returned an invalid model identifier; no setting was changed.');
    const levels = entry.supported_reasoning_levels;
    if (levels !== undefined && (!Array.isArray(levels) || levels.some((level: any) => !validModelName(level?.effort))))
      throw new Failure('transport/service-error', 'Codex returned invalid reasoning metadata; no setting was changed.');
    result.push({ name: entry.slug, remote: true, efforts: levels?.map((level: any) => level.effort) });
  }
  return result;
}

export async function listCodexModels(config: Config, signal: AbortSignal, report: (line: string) => void): Promise<PickerModel[]> {
  await pickerDependency('codex', signal);
  const directory = await mkdtemp(join(tmpdir(), 'git-ai-codex-models-'));
  try {
    const args = ['debug', 'models', ...(config.allowCloud ? [] : ['--bundled']),
      '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"'];
    report(config.allowCloud ? 'Reading the Codex CLI model catalog (refresh may use existing authentication); no repository data or inference.'
      : 'Cloud use is blocked; reading the bundled Codex catalog offline. Account access is not verified.');
    const result = await run('codex', args, { cwd: directory, env: codexEnvironment(directory), signal,
      timeoutMs: config.timeoutSeconds * 1000, limit: 8_000_000 });
    if (result.code !== 0) throw new Failure('unavailable', 'Codex model listing failed. Check codex debug models --help, CLI version and authentication; raw logs suppressed.');
    let data;
    try { data = JSON.parse(result.stdout); }
    catch { throw new Failure('transport/service-error', 'Codex returned invalid catalog JSON; raw output suppressed.'); }
    report('Catalog entries may be bundled/cached; a listed model does not guarantee account entitlement.');
    return codexModels(data);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function selectCodexModel(config: Config, scope: 'global' | 'local', signal: AbortSignal,
  report: (line: string) => void): Promise<number> {
  return await selectModel(config, 'codex', scope, signal, report, () => listCodexModels(config, signal, report));
}
