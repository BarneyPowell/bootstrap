import type { Config } from './config.ts';
import { Failure, cancelled, diagnostic } from './errors.ts';
import { run } from './process.ts';

export type PickerModel = { name: string; remote: boolean; efforts?: string[]; aliases?: string[] };
type PickerProvider = 'ollama' | 'codex' | 'claude';

const matchesCurrent = (model: PickerModel, current?: string) => model.name === current || (current !== undefined && !!model.aliases?.includes(current));

export function validModelName(name: unknown): name is string {
  return typeof name === 'string' && !!name.trim() && name === name.trim() && name.length <= 200 &&
    !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(name);
}

export function buildModelChoices(models: PickerModel[], current?: string) {
  const unique = new Map<string, PickerModel>();
  for (const model of models) {
    if (!validModelName(model.name)) throw new Failure('transport/service-error', 'Provider returned an invalid model identifier; no setting was changed.');
    const previous = unique.get(model.name);
    unique.set(model.name, { ...model, remote: model.remote || (previous?.remote ?? false),
      ...(model.aliases || previous?.aliases ? { aliases: [...new Set([...(previous?.aliases ?? []), ...(model.aliases ?? [])])] } : {}),
    });
  }
  return [...unique.values()].sort((a, b) => matchesCurrent(a, current) ? -1 : matchesCurrent(b, current) ? 1 : a.name.localeCompare(b.name))
    .map((model, i) => ({ model, label: `${i + 1}. ${model.name}${matchesCurrent(model, current) ? '  (current default)' : ''}${model.remote ? '  [remote model]' : ''}` }));
}

export async function pickerDependency(name: 'gum' | 'ollama' | 'codex' | 'claude', signal: AbortSignal): Promise<void> {
  try {
    const result = await run(name, ['--version'], { signal, timeoutMs: 3000 });
    if (result.code === 0) return;
  } catch (error) {
    cancelled(signal);
    if (!(error instanceof Failure)) throw error;
  }
  const guidance = name === 'gum' ? 'gum is unavailable. Run make ensure-gum from the bootstrap clone, then retry.'
    : name === 'ollama' ? 'Ollama CLI is unavailable. Install Ollama yourself, start its service, then retry.'
    : name === 'codex' ? 'Codex CLI is unavailable. Install Codex separately, then retry.'
    : 'Claude CLI is unavailable. Install Claude Code separately, then retry.';
  throw new Failure('not-installed', guidance);
}

export async function selectModel(config: Config, provider: PickerProvider, scope: 'global' | 'local', signal: AbortSignal,
  report: (line: string) => void, load: () => Promise<PickerModel[]>): Promise<number> {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Failure('unavailable', 'Model selection requires an interactive terminal.');
  if (scope === 'local' && (await run('git', ['rev-parse', '--git-dir'], { signal })).code !== 0)
    throw new Failure('configuration-invalid', '--local requires a Git repository; omit it to save the global default.');
  await pickerDependency('gum', signal);
  const key = `ai.${provider}.model`;
  const title = { codex: 'Codex', ollama: 'Ollama', claude: 'Claude' }[provider];
  const saved = await run('git', ['config', `--${scope}`, '--includes', '--get', key], { signal });
  if (![0, 1].includes(saved.code)) throw new Failure('configuration-invalid', `Cannot read the ${scope} ${key} setting.`);
  const current = saved.code === 0 ? saved.stdout.replace(/\n$/, '') : undefined;
  const choices = buildModelChoices(await load(), current);
  if (!choices.length) throw new Failure('unavailable', provider === 'ollama'
    ? 'Ollama has no installed models. Install a model yourself, then retry; no setting was changed.'
    : `${title} returned no visible models. Check its CLI catalog, version and authentication; no setting was changed.`);
  const present = choices.some(choice => matchesCurrent(choice.model, current));
  const header = [`Default ${title} model (${scope})`, `Current ${scope}: ${diagnostic(current ?? '(not set)')}${current && !present ? ' — not available on this service/catalog' : ''}`];
  if (scope === 'global' && config.models[provider] !== current)
    header.push(`Effective here: ${diagnostic(config.models[provider] ?? '(not set)')} — repository/environment overrides may take precedence`);
  header.push('Enter to save · Esc/Ctrl+C to cancel');
  const result = await run('gum', ['choose', '--limit=1', '--selected=', '--timeout=0s',
    `--header=${header.join('\n')}`, '--', ...choices.map(choice => choice.label)],
  { signal, interactive: true, timeoutMs: 0, limit: 4096 });
  cancelled(signal);
  if (![0, 1, 130].includes(result.code))
    throw new Failure('unavailable', 'gum selection failed; no configuration was changed. Check your gum installation.');
  if (result.code !== 0 || !result.stdout.trim()) {
    report(`Selection cancelled; ${key} is unchanged.`);
    return result.code === 130 ? 130 : 0;
  }
  const selected = choices.find(choice => choice.label === result.stdout.replace(/\r?\n$/, ''))?.model;
  if (!selected) throw new Failure('invalid-output', 'gum returned a value outside the model list; no configuration was changed.');
  const write = await run('git', ['config', `--${scope}`, '--replace-all', '--', key, selected.name], { signal });
  if (write.code !== 0) throw new Failure('configuration-invalid', `Cannot save ${scope} ${key}. Check Git config file permissions.`);
  report(`Saved ${scope} ${key}=${diagnostic(selected.name)}. Provider order is unchanged.`);
  const effective = await run('git', ['config', '--get', key], { signal });
  if (effective.code === 0 && effective.stdout.replace(/\n$/, '') !== selected.name)
    report(`Effective model here remains ${diagnostic(effective.stdout.replace(/\n$/, ''))}; a higher-priority Git setting overrides the saved default.`);
  if (selected.remote && !config.allowCloud) report('This model is marked remote. Inference remains blocked while ai.allowCloud=false.');
  if (config.efforts[provider] && selected.efforts && !selected.efforts.includes(config.efforts[provider]!))
    report(`The catalog does not list ${diagnostic(config.efforts[provider])} effort for this model. ai.${provider}.reasoningEffort was left unchanged; review it before generation.`);
  return 0;
}
