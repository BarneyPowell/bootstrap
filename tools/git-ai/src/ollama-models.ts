import type { Config } from './config.ts';
import { Failure, cancelled } from '../../shared/src/errors.ts';
import { httpJSON, isLoopback } from './providers.ts';
import { buildModelChoices, pickerDependency, selectModel } from './model-picker.ts';

export function modelChoices(data: unknown, current?: string) {
  if (!data || !Array.isArray((data as any).models))
    throw new Failure('transport/service-error', 'Ollama returned an invalid model list.');
  return buildModelChoices((data as any).models.map((entry: any) => ({
    name: entry?.name ?? entry?.model, remote: !!(entry?.remote_host || entry?.remote_model),
  })), current);
}

export async function selectOllamaModel(config: Config, scope: 'global' | 'local', signal: AbortSignal,
  report: (line: string) => void): Promise<number> {
  return await selectModel(config, 'ollama', scope, signal, report, async () => {
    await pickerDependency('ollama', signal);
    if (!isLoopback(config.endpoint) && !config.allowCloud)
      throw new Failure('privacy-blocked', 'A non-loopback Ollama endpoint requires effective Git config ai.allowCloud=true.');
    const deadline = AbortSignal.timeout(config.timeoutSeconds * 1000);
    try {
      const data = await httpJSON(config.endpoint, '/api/tags', undefined, AbortSignal.any([signal, deadline]));
      return modelChoices(data).map(choice => choice.model);
    } catch (error) {
      cancelled(signal);
      if (deadline.aborted) throw new Failure('timeout', 'Ollama model listing timed out. Check that the service is running.');
      throw error;
    }
  });
}
