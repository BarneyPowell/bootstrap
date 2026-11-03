import { createAdapter as createTaskAdapter } from '../../shared/src/ai/providers.ts';
import type { Adapter, Task } from '../../shared/src/ai/providers.ts';
import type { Config, ProviderName } from './config.ts';
import { instructions } from './prompt.ts';

export { httpJSON, isLoopback, executableVersion } from '../../shared/src/ai/providers.ts';
export type { Adapter, Capabilities } from '../../shared/src/ai/providers.ts';

// prepare() embeds the instructions in every commit prompt, so local models run it raw.
export const commitTask: Task = {
  tool: 'git-ai', instructions, selfContained: true, maxOutputTokens: 512, maxOutputBytes: 8000, temperature: 0.2,
};

export const createAdapter = (name: ProviderName, config: Config): Adapter => createTaskAdapter(name, config, commitTask);
