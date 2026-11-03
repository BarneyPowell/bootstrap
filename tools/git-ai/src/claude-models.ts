import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { Failure } from '../../shared/src/errors.ts';
import { run } from '../../shared/src/process.ts';
import { pickerDependency, selectModel, validModelName } from './model-picker.ts';
import type { PickerModel } from './model-picker.ts';

const requestId = 'git-ai-model-list';

// The same initialize envelope used by the official Agent SDK. Deliberately
// send no user message: model discovery must not start a generation turn.
export const claudeModelRequest = JSON.stringify({
  type: 'control_request', request_id: requestId,
  request: { subtype: 'initialize', hooks: null, skills: [] },
}) + '\n';

export function claudeModels(stdout: string): PickerModel[] {
  let payload: any;
  for (const line of stdout.split('\n').filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Failure('transport/service-error', 'Claude returned invalid model metadata JSON; raw output suppressed.'); }
    if (!event || typeof event !== 'object') throw new Failure('transport/service-error', 'Claude returned an invalid metadata event.');
    if (event.type === 'assistant' || event.type === 'user' || event.type === 'result')
      throw new Failure('unavailable', 'Claude started an unexpected generation turn during model discovery; selection refused.');
    if (event.type !== 'control_response' || event.response?.request_id !== requestId) continue;
    const response = event.response;
    if (response.subtype !== 'success')
      throw new Failure('unavailable', 'Claude model initialization failed. Check CLI compatibility and authentication; no login was started.');
    if (response.pending_permission_requests !== undefined && (!Array.isArray(response.pending_permission_requests) || response.pending_permission_requests.length))
      throw new Failure('unavailable', 'Claude requested permissions during model discovery; none were granted. Check CLI settings and managed policy.');
    payload = response.response;
  }
  if (!payload || !Array.isArray(payload.models))
    throw new Failure('unavailable', 'Claude initialization did not return a model list. Update/check Claude Code; no setting was changed.');
  const models: PickerModel[] = [];
  for (const entry of payload.models) {
    if (!entry || !validModelName(entry.value) || (entry.resolvedModel !== undefined && !validModelName(entry.resolvedModel)))
      throw new Failure('transport/service-error', 'Claude returned an invalid model identifier; no setting was changed.');
    // Never save an unresolved automatic/inherited selection as an explicit ID.
    if (!entry.resolvedModel && ['default', 'inherit', 'opusplan'].includes(entry.value)) continue;
    let name = entry.resolvedModel ?? entry.value;
    // The resolved ID can omit an explicit context-window suffix from value.
    const suffix = /\[[a-zA-Z0-9]+\]$/.exec(entry.value)?.[0];
    if (suffix && !name.endsWith(suffix)) name += suffix;
    if (!validModelName(name)) throw new Failure('transport/service-error', 'Claude returned an invalid resolved model identifier.');
    if (entry.supportedEffortLevels !== undefined && (!Array.isArray(entry.supportedEffortLevels) || !entry.supportedEffortLevels.every(validModelName)))
      throw new Failure('transport/service-error', 'Claude returned invalid reasoning metadata; no setting was changed.');
    models.push({ name, remote: true, aliases: [entry.value],
      efforts: entry.supportedEffortLevels ?? (entry.supportsEffort === false ? [] : undefined) });
  }
  return models;
}

export async function listClaudeModels(config: Config, signal: AbortSignal, report: (line: string) => void): Promise<PickerModel[]> {
  await pickerDependency('claude', signal);
  const directory = await mkdtemp(join(tmpdir(), 'git-ai-claude-models-'));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, PWD: directory, INIT_CWD: directory, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    report('Reading Claude CLI initialization metadata; no user prompt or inference. CLI authentication/metadata checks may contact its services.');
    const result = await run('claude', ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--safe-mode', '--restricted', '--tools', '', '--disable-slash-commands',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
      '--settings', '{"disableAllHooks":true}', '--no-chrome'],
    { cwd: directory, env, signal, input: claudeModelRequest, timeoutMs: config.timeoutSeconds * 1000, limit: 2_000_000 });
    if (result.code !== 0) throw new Failure('unavailable', 'Claude model listing failed. Check Claude Code version and authentication; raw logs suppressed.');
    const models = claudeModels(result.stdout);
    report('Claude model choices are CLI metadata; account entitlement is not verified by listing.');
    return models;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function selectClaudeModel(config: Config, scope: 'global' | 'local', signal: AbortSignal,
  report: (line: string) => void): Promise<number> {
  return await selectModel(config, 'claude', scope, signal, report, () => listClaudeModels(config, signal, report));
}
