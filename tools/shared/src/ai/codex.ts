import { mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiConfig } from './config.ts';
import type { Adapter, Task } from './providers.ts';
import { Failure } from '../errors.ts';
import { run } from '../process.ts';

const requiredFeatures = ['shell_tool', 'hooks', 'apps', 'plugins', 'multi_agent', 'memories'];
const optionalFeatures = [
  'shell_snapshot',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'code_mode',
  'code_mode_host',
  'view_image',
  'skill_search',
  'skill_mcp_dependency_install',
  'workspace_dependencies',
  'sleep_tool',
  'plugin_discovery_prefetch',
  'tool_suggest',
  'multi_agent_v2',
];

// This is a constrained CLI integration, not a claim of a filesystem security
// boundary. The installed CLI and any managed policy must still be trusted.
export function codexEnvironment(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PWD: directory, INIT_CWD: directory };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') || ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'].includes(key)) delete env[key];
  }
  return env;
}

function executionFailure(logs: string, tool: string): Failure {
  if (/unauthorized|not logged|log ?in|auth|\b401\b|\b403\b|token.*expired/i.test(logs))
    return new Failure(
      'auth-required',
      `Codex needs existing ChatGPT CLI authentication. Run codex login separately; ${tool} does not log in or switch to paid API credentials.`,
    );
  if (/context.{0,40}(window|length|limit)|too many tokens|maximum context/i.test(logs))
    return new Failure('context-too-large', 'Codex rejected the prepared context as too large.');
  if (
    /reasoning.{0,50}(unsupported|invalid|not support)|unknown model|model.{0,50}(not found|not exist|not support)|unsupported.{0,20}model/i.test(
      logs,
    )
  )
    return new Failure(
      'configuration-invalid',
      'Codex rejected ai.codex.model or ai.codex.reasoningEffort. Check model access and supported effort; no setting was discarded.',
    );
  return new Failure(
    'transport/service-error',
    'Codex execution failed. Check CLI authentication, model access, service limits and supported configuration; raw logs suppressed.',
  );
}

export function checkCodexEvents(stdout: string): { error: string; warnings: string; completed: boolean } {
  let error = '',
    warnings = '',
    completed = false;
  for (const line of stdout.split('\n').filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Failure('transport/service-error', 'Codex emitted an invalid JSON event; raw output suppressed.');
    }
    if (!event || typeof event !== 'object' || Array.isArray(event))
      throw new Failure('transport/service-error', 'Codex emitted an invalid JSON event shape; raw output suppressed.');
    const itemType = event.item?.type;
    if (itemType === 'error') {
      // Codex uses error *items* for non-fatal CLI warnings too. Keep them for
      // failure classification, but successful turn completion is authoritative.
      warnings += JSON.stringify(event.item).slice(0, 4096);
    } else if (itemType && !['agent_message', 'reasoning', 'todo_list'].includes(itemType)) {
      const type = typeof itemType === 'string' && /^[a-z_]{1,64}$/.test(itemType) ? itemType : 'invalid_type';
      const action = ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(itemType);
      throw new Failure(
        'unavailable',
        action
          ? `Codex emitted a ${type} action despite the requested constraints; result refused.`
          : `Codex emitted an unsupported item type (${type}); result refused. Update/check CLI event compatibility.`,
      );
    }
    if (['error', 'turn.failed', 'thread.failed'].includes(event.type)) error += JSON.stringify(event).slice(0, 4096);
    if (event.type === 'turn.completed') completed = true;
  }
  return { error, warnings, completed };
}

export function createCodexAdapter(config: AiConfig, task: Task): Adapter {
  let disabled: string[] | undefined;
  const model = config.models.codex;
  function policy() {
    if (!config.allowCloud)
      throw new Failure('privacy-blocked', 'Codex requires effective Git config ai.allowCloud=true.');
    if (!model)
      throw new Failure('model-not-configured', 'Set ai.codex.model to an explicit supported model identifier.');
  }
  const adapter: Adapter = {
    name: 'codex',
    async probe(signal) {
      policy();
      const directory = await mkdtemp(join(tmpdir(), `${task.tool}-codex-probe-`));
      try {
        const env = codexEnvironment(directory);
        const help = await run('codex', ['exec', '--help'], { cwd: directory, env, signal });
        if (
          help.code !== 0 ||
          [
            '--ignore-user-config',
            '--ephemeral',
            '--skip-git-repo-check',
            '--output-last-message',
            '--sandbox',
            '--json',
          ].some(flag => !help.stdout.includes(flag))
        )
          throw new Failure(
            'unavailable',
            'Installed Codex CLI lacks required exec controls. Update it separately; no prompt was sent.',
          );
        const features = await run('codex', ['features', 'list'], { cwd: directory, env, signal });
        const names = new Set(features.stdout.split('\n').map(line => line.trim().split(/\s+/)[0]));
        if (features.code !== 0 || requiredFeatures.some(name => !names.has(name)))
          throw new Failure(
            'unavailable',
            'Codex feature controls could not be verified. Check the installed CLI and its configuration; no prompt was sent.',
          );
        disabled = [...requiredFeatures, ...optionalFeatures.filter(name => names.has(name))];
        return {
          model: model!,
          locality: 'remote',
          inputBytes: 65_536,
          detail:
            'Codex exec controls verified; private cwd, read-only sandbox, tool/integration features disabled. Authentication/model entitlement unverified without inference; input cap 64 KiB.',
        };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async generate(prompt, signal) {
      policy();
      if (!disabled) await adapter.probe(signal);
      const directory = await mkdtemp(join(tmpdir(), `${task.tool}-codex-`));
      try {
        const messageFile = join(directory, 'message');
        const instructionsFile = join(directory, 'instructions');
        await writeFile(messageFile, '', { mode: 0o600 });
        await writeFile(instructionsFile, task.instructions, { mode: 0o600 });
        const args = [
          'exec',
          '--ignore-user-config',
          '--ephemeral',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          '--model',
          model!,
          '--color',
          'never',
          '--json',
          '--output-last-message',
          messageFile,
          '-c',
          'approval_policy="never"',
          '-c',
          'forced_login_method="chatgpt"',
          '-c',
          'model_provider="openai"',
          '-c',
          'web_search="disabled"',
          '-c',
          'mcp_servers={}',
          '-c',
          'project_doc_max_bytes=0',
          '-c',
          `model_instructions_file=${JSON.stringify(instructionsFile)}`,
          ...disabled!.flatMap(name => ['--disable', name]),
        ];
        if (config.efforts.codex !== undefined)
          args.push('-c', `model_reasoning_effort=${JSON.stringify(config.efforts.codex)}`);
        args.push('-');
        const result = await run('codex', args, {
          cwd: directory,
          env: codexEnvironment(directory),
          signal,
          input: prompt,
          timeoutMs: 0,
        });
        if (result.code === 130) throw new Failure('cancelled', 'Codex cancelled.');
        const events = checkCodexEvents(result.stdout);
        if (result.code !== 0 || events.error || !events.completed)
          throw executionFailure(result.stderr + events.error + events.warnings, task.tool);
        const info = await lstat(messageFile);
        if (!info.isFile() || info.isSymbolicLink() || info.size > task.maxOutputBytes)
          throw new Failure(
            'invalid-output',
            `Codex final message file is invalid or exceeds ${task.maxOutputBytes} bytes.`,
          );
        return await readFile(messageFile, 'utf8');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
  return adapter;
}
