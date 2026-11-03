import { configReader, invalid, loadAiConfig, providers } from '../../shared/src/ai/config.ts';
import type { AiConfig, AiOverrides, ProviderName } from '../../shared/src/ai/config.ts';

export { providers };
export type { ProviderName };
export type Overrides = AiOverrides & { dryRun?: boolean; plain?: boolean };
export type Config = AiConfig & {
  contextFallback: 'ask' | 'auto' | 'never';
  recentCount: number; subjectMaxLength: number;
};

export async function loadConfig(overrides: Overrides = {}, cwd?: string, signal?: AbortSignal): Promise<Config> {
  const reader = configReader(cwd, signal);
  const shared = await loadAiConfig(overrides, reader);
  const contextFallback = (await reader.read('ai.commit.contextFallback')) ?? 'ask';
  if (!['ask', 'auto', 'never'].includes(contextFallback))
    invalid('ai.commit.contextFallback', 'expected ask, auto, or never.');
  const recentCount = await reader.integer('ai.commit.recentCount', 8, 0, 100);
  const subjectMaxLength = await reader.integer('ai.commit.subjectMaxLength', 72, 1, 1000);
  return { ...shared, contextFallback: contextFallback as Config['contextFallback'], recentCount, subjectMaxLength };
}
