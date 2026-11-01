import { isIP } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './process.ts';
import type { Config, ProviderName } from './config.ts';
import { Failure, cancelled } from './errors.ts';
import { createCodexAdapter } from './codex.ts';
import { createClaudeAdapter } from './claude.ts';

export type Capabilities = { model: string; locality: 'local' | 'remote'; inputBytes: number; detail: string };
export interface Adapter {
  name: ProviderName;
  probe(signal: AbortSignal): Promise<Capabilities>;
  generate(prompt: string, signal: AbortSignal): Promise<string>;
}

export async function executableVersion(name: 'codex' | 'claude', signal: AbortSignal): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'git-ai-probe-'));
  try {
    const result = await run(name, ['--version'], { cwd: directory, signal, timeoutMs: 3000 });
    if (result.code !== 0) throw new Failure('unavailable', `${name} version check failed.`);
    return result.stdout.trim();
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function fm(args: string[], signal: AbortSignal, input?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'git-ai-fm-'));
  try { return await run('fm', args, { cwd: directory, signal, input, limit: 32_768 }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

const plainProbe = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, '');

async function appleProbe(signal: AbortSignal, context: number): Promise<Capabilities> {
  // fm ignores HOME for its config path. Refuse custom-provider defaults rather
  // than risking transmission through a user's configured remote provider.
  const configured = await fm(['config', 'get', 'default-model-provider'], signal);
  if (configured.code !== 0 || plainProbe(configured.stdout).trim() !== '(none)')
    throw new Failure('unavailable', 'fm has a custom provider default or unreadable configuration. Apple requires the built-in system provider; no prompt was sent. Check fm config.');
  const result = await fm(['models'], signal);
  // fm models exits nonzero if PCC is unavailable even when system is ready.
  if (!/^\s*✓\s+system\s+\(/m.test(plainProbe(result.stdout)))
    throw new Failure('unavailable', 'fm system model is unavailable. Check fm models, Apple Intelligence readiness, and fm license --status. git-ai never accepts terms for you.');
  return { model: 'system', locality: 'local', inputBytes: context - 1024,
    detail: `fm system model available; ${context}-token budget from ai.apple.maxContext (CLI does not expose context size); inference not probed.` };
}

export function isLoopback(endpoint: string): boolean {
  const host = new URL(endpoint).hostname;
  return host === 'localhost' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'));
}

// No redirects, implicit retries, model pulls, or unbounded response bodies.
export async function httpJSON(endpoint: string, path: string, body: unknown, signal: AbortSignal): Promise<any> {
  cancelled(signal);
  let response: Response;
  try {
    response = await fetch(endpoint + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal });
  } catch {
    cancelled(signal);
    throw new Failure('transport/service-error', 'Ollama connection failed. Start the service yourself and check ai.ollama.endpoint; redirects are refused.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    if ([401, 403].includes(response.status)) throw new Failure('auth-required', 'Ollama requires authentication; configure the service outside git-ai.');
    throw new Failure('transport/service-error', `Ollama returned HTTP ${response.status}; check service and installed model.`);
  }
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2_000_000) { await reader.cancel(); throw new Failure('transport/service-error', 'Ollama response exceeds the safety limit.'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    cancelled(signal);
    if (error instanceof Failure) throw error;
    throw new Failure('transport/service-error', 'Ollama returned an unreadable response.');
  } finally { reader.releaseLock(); }
}

export function createAdapter(name: ProviderName, config: Config): Adapter {
  if (name === 'codex') return createCodexAdapter(config);
  if (name === 'claude') return createClaudeAdapter(config);
  const model = config.models[name] ?? (name === 'apple' ? 'system' : '');
  let context = 0;
  let locality: Capabilities['locality'] = name === 'apple' || (name === 'ollama' && isLoopback(config.endpoint)) ? 'local' : 'remote';
  return {
    name,
    async probe(signal) {
      if (locality === 'remote' && !config.allowCloud)
        throw new Failure('privacy-blocked', 'Remote inference requires effective Git config ai.allowCloud=true.');
      if (!model) throw new Failure('model-not-configured', `Set ai.${name}.model to an explicit supported model identifier.`);
      if (name === 'apple') {
        return await appleProbe(signal, config.maxContext.apple);
      }
      if (name === 'ollama') {
        const tags = await httpJSON(config.endpoint, '/api/tags', undefined, signal);
        const installed = tags.models?.find((item: any) => item.name === model || item.model === model);
        if (!installed) throw new Failure('unavailable', 'Configured Ollama model is not installed. Use ollama list; git-ai never pulls models.');
        if (installed.remote_host || installed.remote_model) {
          locality = 'remote';
          if (!config.allowCloud) throw new Failure('privacy-blocked', 'Ollama reports this model as remote; ai.allowCloud=true is required.');
        }
        const info = await httpJSON(config.endpoint, '/api/show', { model }, signal);
        const arch = info.model_info?.['general.architecture'];
        context = info.model_info?.[`${arch}.context_length`];
        if (!Number.isSafeInteger(context) || context < 1024) throw new Failure('unavailable', 'Ollama does not report a usable model context_length.');
        context = Math.min(context, config.maxContext.ollama);
        return { model, locality, inputBytes: context - 1024, detail: `Model present; using ${context} tokens of reported context, with conservative byte budgeting; inference not probed.` };
      }
      throw new Failure('unavailable', `${name} provider is not handled by this adapter.`);
    },
    async generate(prompt, signal) {
      if (name === 'apple') {
        // Recheck the custom-provider default immediately before handling content.
        await appleProbe(signal, config.maxContext.apple);
        const count = await fm(['count-tokens', '--quiet'], signal, prompt);
        const tokens = Number(count.stdout.trim());
        if (count.code !== 0 || !/^\d+$/.test(count.stdout.trim()) || !Number.isSafeInteger(tokens) || tokens <= 0)
          throw new Failure('unavailable', 'fm could not count tokens for the on-device model. Check Apple Intelligence readiness.');
        if (tokens > config.maxContext.apple - 1024) throw new Failure('context-too-large', 'fm prompt exceeds the configured on-device context budget (ai.apple.maxContext).');
        const result = await fm(['respond', '--model', 'system', '--use-case', 'general', '--guardrails', 'default', '--no-stream', '--greedy'], signal, prompt);
        // A raised ai.apple.maxContext can exceed the real window. Classify that overflow (stderr is never
        // surfaced) so it escalates like any context failure instead of reading as a service error.
        if (result.code !== 0 && /exceeded the model's context size/i.test(result.stderr))
          throw new Failure('context-too-large', 'fm reported the prompt exceeds the on-device context size; lower ai.apple.maxContext.');
        if (result.code !== 0) throw new Failure('transport/service-error', 'fm generation failed. Check fm models and Apple Intelligence readiness; raw diagnostics suppressed.');
        return result.stdout;
      }
      if (name === 'ollama') {
        const data = await httpJSON(config.endpoint, '/api/generate', {
          model, prompt, raw: true, stream: false,
          keep_alive: /^-?\d+$/.test(config.ollamaKeepAlive) ? Number(config.ollamaKeepAlive) : config.ollamaKeepAlive,
          options: { num_ctx: context, num_predict: 512, temperature: 0.2 },
        }, signal);
        if (data.error || data.done !== true) throw new Failure('transport/service-error', 'Ollama did not complete generation.');
        if (data.model !== undefined && data.model !== model) throw new Failure('configuration-invalid', 'Ollama returned a different model identifier; model substitution is refused.');
        return data.response;
      }
      throw new Failure('unavailable', `${name} text-only adapter is disabled. No request was sent.`);
    },
  };
}
