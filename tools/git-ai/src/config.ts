import { run } from './process.ts';
import { Failure } from './errors.ts';

export const providers = ['apple', 'ollama', 'codex', 'claude'] as const;
export type ProviderName = typeof providers[number];
export type Overrides = { provider?: ProviderName; model?: string; reasoningEffort?: string; dryRun?: boolean; plain?: boolean };
export type Config = {
  providers: ProviderName[]; allowCloud: boolean; timeoutSeconds: number;
  contextFallback: 'ask' | 'auto' | 'never'; pinned: boolean;
  recentCount: number; subjectMaxLength: number; endpoint: string;
  maxContext: { apple: number; ollama: number }; ollamaKeepAlive: string;
  models: Partial<Record<ProviderName, string>>;
  efforts: Partial<Record<ProviderName, string>>;
  origins: Record<string, string>;
};

function invalid(key: string, guidance: string): never {
  throw new Failure('configuration-invalid', `${key}: ${guidance} Use git config --unset ${key} to restore its default.`);
}

export async function loadConfig(overrides: Overrides = {}, cwd?: string, signal?: AbortSignal): Promise<Config> {
  const origins: Record<string, string> = {};
  async function read(key: string, boolean = false): Promise<string | undefined> {
    const args = ['config', ...(boolean ? ['--bool'] : []), '--get', key];
    const result = await run('git', args, { cwd, signal });
    if (result.code === 1) return undefined;
    if (result.code !== 0) invalid(key, boolean ? 'expected a Git boolean (true or false).' : 'could not read effective Git configuration.');
    const origin = await run('git', ['config', '--show-origin', '--get', key], { cwd, signal });
    origins[key] = origin.stdout.split('\t')[0];
    return result.stdout.replace(/\n$/, '');
  }
  async function integer(key: string, fallback: number, min: number, max: number): Promise<number> {
    const value = await read(key);
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max)
      invalid(key, `expected an integer from ${min} to ${max}.`);
    return Number(value);
  }
  const list = ((await read('ai.providers')) ?? providers.join(',')).split(',').map(p => p.trim());
  if (list.some(p => !providers.includes(p as ProviderName)) || new Set(list).size !== list.length)
    invalid('ai.providers', 'expected a non-empty, comma-separated list of unique apple, ollama, codex, claude providers.');
  const allowCloud = (await read('ai.allowCloud', true)) === 'true';
  const contextFallback = (await read('ai.commit.contextFallback')) ?? 'ask';
  if (!['ask', 'auto', 'never'].includes(contextFallback))
    invalid('ai.commit.contextFallback', 'expected ask, auto, or never.');
  const timeoutSeconds = await integer('ai.timeoutSeconds', 30, 1, 3600);
  const recentCount = await integer('ai.commit.recentCount', 8, 0, 100);
  const subjectMaxLength = await integer('ai.commit.subjectMaxLength', 72, 1, 1000);
  // Token ceilings for local providers. Defaults are conservative; each reserves 1024 tokens for output.
  const maxContext = { apple: await integer('ai.apple.maxContext', 4096, 2048, 32768),
    ollama: await integer('ai.ollama.maxContext', 8192, 2048, 131072) };
  const ollamaKeepAlive = (await read('ai.ollama.keepAlive')) ?? '0';
  if (!/^(?:-1|\d+|\d+[smh])$/.test(ollamaKeepAlive))
    invalid('ai.ollama.keepAlive', 'expected -1, a number of seconds, or a duration such as 30s, 10m or 1h.');
  const models: Config['models'] = {}, efforts: Config['efforts'] = {};
  for (const provider of providers) {
    const model = overrides.provider === provider && overrides.model !== undefined ? overrides.model : await read(`ai.${provider}.model`);
    if (model !== undefined) {
      if (!model.trim() || /[\x00-\x1f\x7f]/.test(model) || model.length > 200) invalid(`ai.${provider}.model`, 'expected a non-empty model identifier without control characters (max 200 characters).');
      if (provider === 'apple' && model !== 'system') invalid('ai.apple.model', 'only the on-device identifier "system" is supported.');
      models[provider] = model;
    }
    const effort = overrides.provider === provider && overrides.reasoningEffort !== undefined ? overrides.reasoningEffort : await read(`ai.${provider}.reasoningEffort`);
    if (effort !== undefined) {
      const allowed = provider === 'codex' ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] : provider === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : [];
      if (!allowed.includes(effort)) invalid(`ai.${provider}.reasoningEffort`, `unsupported reasoning effort; supported values: ${allowed.join(', ') || 'none for this provider'}.`);
      efforts[provider] = effort;
    }
  }
  const endpoint = (await read('ai.ollama.endpoint')) ?? 'http://127.0.0.1:11434';
  let url: URL;
  try { url = new URL(endpoint); } catch { invalid('ai.ollama.endpoint', 'expected an absolute HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    invalid('ai.ollama.endpoint', 'expected an HTTP(S) origin without credentials, path, query, or fragment.');
  if (overrides.provider && overrides.provider !== 'apple' && !models[overrides.provider])
    invalid(`ai.${overrides.provider}.model`, 'a pinned provider requires an explicit model; set this key or pass --model <id>.');
  return { providers: overrides.provider ? [overrides.provider] : list as ProviderName[], allowCloud, timeoutSeconds,
    contextFallback: contextFallback as Config['contextFallback'], pinned: !!overrides.provider,
    recentCount, subjectMaxLength, endpoint: url.origin, maxContext, ollamaKeepAlive, models, efforts, origins };
}
