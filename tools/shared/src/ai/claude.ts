import type { AiConfig } from './config.ts';
import type { Adapter, Task } from './providers.ts';
import { Failure } from '../errors.ts';
import { run, scratch } from '../process.ts';

const requiredFlags = [
  '--print',
  '--output-format',
  '--include-hook-events',
  '--no-session-persistence',
  '--safe-mode',
  '--restricted',
  '--tools',
  '--disable-slash-commands',
  '--strict-mcp-config',
  '--mcp-config',
  '--setting-sources',
  '--settings',
  '--system-prompt',
  '--permission-prompts',
  '--no-chrome',
  '--model',
  '--effort',
];

// This is a constrained CLI integration, not a claim of a filesystem security
// boundary. The installed CLI and any managed (policy) settings must still be
// trusted: managed hooks are not removable from the command line.
export function claudeEnvironment(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PWD: directory,
    INIT_CWD: directory,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('GIT_') ||
      [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_VERTEX',
        'CLAUDE_CODE_USE_FOUNDRY',
      ].includes(key)
    )
      delete env[key];
  }
  return env;
}

function executionFailure(logs: string, tool: string): Failure {
  if (
    /not logged in|\/login|unauthorized|authentication|invalid.{0,20}(api key|token)|\b401\b|\b403\b|oauth|token.{0,30}expired/i.test(
      logs,
    )
  )
    return new Failure(
      'auth-required',
      `Claude needs existing Claude Code CLI authentication. Run claude login separately; ${tool} does not log in or switch to paid API credentials.`,
    );
  if (/prompt is too long|context.{0,40}(window|length|limit)|too many tokens|maximum context/i.test(logs))
    return new Failure('context-too-large', 'Claude rejected the prepared context as too large.');
  if (
    /issue with the selected model|model.{0,60}(not found|not exist|not available|not support|invalid)|unknown model|effort/i.test(
      logs,
    )
  )
    return new Failure(
      'configuration-invalid',
      'Claude rejected ai.claude.model or ai.claude.reasoningEffort. Check model access and supported effort; no setting was discarded.',
    );
  return new Failure(
    'transport/service-error',
    'Claude execution failed. Check CLI authentication, model access, service limits and supported configuration; raw logs suppressed.',
  );
}

const emptyList = (value: unknown) => Array.isArray(value) && value.length === 0;

// The init event reports the session the CLI actually built. Verify it matches
// what was requested rather than trusting that every flag was honoured.
function checkInit(event: any): void {
  const mismatch = (what: string) =>
    new Failure(
      'unavailable',
      `Claude session did not match the requested constraints (${what}); result refused. Update/check the CLI and its managed policy.`,
    );
  if (!emptyList(event.tools)) throw mismatch('tools');
  if (!emptyList(event.mcp_servers)) throw mismatch('MCP servers');
  if (!emptyList(event.skills)) throw mismatch('skills');
  if (!emptyList(event.slash_commands)) throw mismatch('slash commands');
  if (!Array.isArray(event.plugins) || event.plugins.some((plugin: any) => plugin?.path !== 'builtin'))
    throw mismatch('plugins');
  if (event.apiKeySource !== 'none')
    throw new Failure(
      'unavailable',
      'Claude did not authenticate through the CLI login (an API-key or token source was reported). Paid API credential substitution is refused; run claude login separately.',
    );
}

export function checkClaudeEvents(stdout: string): { message?: string; error: string } {
  let message: string | undefined,
    error = '',
    initialised = false;
  for (const line of stdout.split('\n').filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Failure('transport/service-error', 'Claude emitted an invalid JSON event; raw output suppressed.');
    }
    if (!event || typeof event !== 'object' || Array.isArray(event))
      throw new Failure(
        'transport/service-error',
        'Claude emitted an invalid JSON event shape; raw output suppressed.',
      );
    if (event.type === 'system') {
      if (typeof event.subtype === 'string' && /hook/i.test(event.subtype))
        throw new Failure(
          'unavailable',
          'Claude reported a hook event despite the requested constraints; result refused. Check managed policy; detecting a hook cannot undo what it did.',
        );
      if (event.subtype === 'init') {
        checkInit(event);
        initialised = true;
      }
    } else if (event.type === 'user') {
      // Tool results come back as user events; no tools were offered.
      throw new Failure(
        'unavailable',
        'Claude emitted a tool exchange despite the requested constraints; result refused.',
      );
    } else if (event.type === 'assistant') {
      const content = event.message?.content;
      if (!Array.isArray(content))
        throw new Failure(
          'transport/service-error',
          'Claude emitted an unreadable assistant message; raw output suppressed.',
        );
      for (const block of content) {
        const type = block?.type;
        if (['text', 'thinking', 'redacted_thinking'].includes(type)) continue;
        const safe = typeof type === 'string' && /^[a-z_]{1,64}$/.test(type) ? type : 'invalid_type';
        throw new Failure(
          'unavailable',
          /tool/.test(safe)
            ? `Claude emitted a ${safe} action despite the requested constraints; result refused.`
            : `Claude emitted an unsupported content type (${safe}); result refused. Update/check CLI event compatibility.`,
        );
      }
    } else if (event.type === 'result') {
      if (event.subtype !== 'success' || event.is_error !== false)
        error += JSON.stringify({ subtype: event.subtype, result: event.result, status: event.api_error_status }).slice(
          0,
          4096,
        );
      else if (!emptyList(event.permission_denials))
        throw new Failure(
          'unavailable',
          'Claude reported denied permissions despite the requested constraints; result refused.',
        );
      else if (typeof event.result === 'string') message = event.result;
    }
    // Other events (rate limits, UI notifications) carry no actions and are ignored.
  }
  if (message !== undefined && !initialised)
    throw new Failure(
      'unavailable',
      'Claude did not report its session constraints; result refused. Update/check CLI event compatibility.',
    );
  return { message, error };
}

export function createClaudeAdapter(config: AiConfig, task: Task): Adapter {
  let verified = false;
  const model = config.models.claude;
  function policy() {
    if (!config.allowCloud)
      throw new Failure('privacy-blocked', 'Claude requires effective Git config ai.allowCloud=true.');
    if (!model)
      throw new Failure('model-not-configured', 'Set ai.claude.model to an explicit supported model identifier.');
  }
  const adapter: Adapter = {
    name: 'claude',
    async probe(signal) {
      policy();
      return await scratch(`${task.tool}-claude-probe-`, async directory => {
        const help = await run('claude', ['--help'], { cwd: directory, env: claudeEnvironment(directory), signal });
        if (help.code !== 0 || requiredFlags.some(flag => !help.stdout.includes(flag)))
          throw new Failure(
            'unavailable',
            'Installed Claude Code CLI lacks required controls. Update it separately; no prompt was sent.',
          );
        verified = true;
        return {
          model: model!,
          locality: 'remote',
          inputBytes: 65_536,
          detail:
            'Claude controls verified; private cwd, no tools/MCP/skills/plugins, user settings ignored, hooks disabled, session not persisted, session constraints re-checked per run. Managed policy hooks cannot be excluded. Authentication/model entitlement unverified without inference; input cap 64 KiB.',
        } as const;
      });
    },
    async generate(prompt, signal) {
      policy();
      if (!verified) await adapter.probe(signal);
      return await scratch(`${task.tool}-claude-`, async directory => {
        const args = [
          '--print',
          '--input-format',
          'text',
          '--output-format',
          'stream-json',
          '--verbose',
          '--include-hook-events',
          '--no-session-persistence',
          '--safe-mode',
          '--restricted',
          '--tools',
          '',
          '--disable-slash-commands',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          '--setting-sources',
          '',
          '--settings',
          '{"disableAllHooks":true}',
          '--no-chrome',
          '--permission-prompts',
          'none',
          `--model=${model}`,
          '--system-prompt',
          task.instructions,
        ];
        if (config.efforts.claude !== undefined) args.push(`--effort=${config.efforts.claude}`);
        const result = await run('claude', args, {
          cwd: directory,
          env: claudeEnvironment(directory),
          signal,
          input: prompt,
          timeoutMs: 0,
        });
        if (result.code === 130) throw new Failure('cancelled', 'Claude cancelled.');
        const events = checkClaudeEvents(result.stdout);
        if (result.code !== 0 || events.error || events.message === undefined)
          throw executionFailure(result.stderr + events.error, task.tool);
        if (Buffer.byteLength(events.message) > task.maxOutputBytes)
          throw new Failure('invalid-output', `Claude's reply exceeds ${task.maxOutputBytes} bytes.`);
        return events.message;
      });
    },
  };
  return adapter;
}
