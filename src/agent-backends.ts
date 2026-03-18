export type AgentKind = "claude" | "opencode" | "codex" | "amux";

export interface AgentModelDefinition {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
}

export interface AgentSpawnOptions {
  prompt: string;
  model: string;
  systemPrompt?: string;
  sessionId?: string;
  skipPermissions: boolean;
  maxTurns: number;
}

export interface ParsedAgentEvent {
  contentDelta?: string;
  resultText?: string;
}

export interface AgentBackend {
  kind: AgentKind;
  label: string;
  summary: string;
  implementationStatus: "implemented" | "scaffold";
  defaultBinary: string;
  defaultModel: string;
  models: AgentModelDefinition[];
  sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  buildArgs(opts: AgentSpawnOptions): string[];
  parseNdjsonEvent(event: { type?: string; [key: string]: any }): ParsedAgentEvent;
}

const PROVIDER_PREFIX_RE = /^(?:terminal-agent-runner|claude-runner)\//;

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function createModel(
  id: string,
  name: string,
  reasoning: boolean,
  input: Array<"text" | "image">,
  contextWindow: number,
  maxTokens: number,
): AgentModelDefinition {
  return {
    id,
    name,
    reasoning,
    input,
    cost: { ...ZERO_COST },
    contextWindow,
    maxTokens,
  };
}

function stripEnvPrefixes(env: NodeJS.ProcessEnv, prefixes: string[]): NodeJS.ProcessEnv {
  const cleaned = { ...env };
  for (const key of Object.keys(cleaned)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      delete cleaned[key];
    }
  }
  return cleaned;
}

function makeScaffoldModel(kind: Exclude<AgentKind, "claude">, label: string): AgentModelDefinition {
  return createModel(`${kind}-default`, `${label} Default (Scaffold)`, true, ["text"], 128_000, 8_192);
}

export function stripProviderPrefix(model: string): string {
  return model.replace(PROVIDER_PREFIX_RE, "");
}

const claudeBackend: AgentBackend = {
  kind: "claude",
  label: "Claude Code CLI",
  summary: "Implemented Claude-compatible backend using stream-json output and Claude-style flags.",
  implementationStatus: "implemented",
  defaultBinary: "claude",
  defaultModel: "claude-opus-4-5",
  models: [
    createModel("claude-opus-4-5", "Claude Opus 4.5 (CLI)", true, ["text", "image"], 200_000, 16_384),
    createModel("claude-sonnet-4-6", "Claude Sonnet 4.6 (CLI)", true, ["text", "image"], 200_000, 16_384),
    createModel("claude-sonnet-4", "Claude Sonnet 4 (CLI)", false, ["text", "image"], 200_000, 8_192),
    createModel("claude-haiku-4-5", "Claude Haiku 4.5 (CLI)", false, ["text"], 200_000, 8_192),
  ],
  sanitizeEnv(env) {
    return stripEnvPrefixes(env, ["CLAUDECODE", "CLAUDE_CODE_"]);
  },
  buildArgs(opts) {
    const args: string[] = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose"];

    if (opts.skipPermissions) {
      args.push("--dangerously-skip-permissions");
    }

    args.push("--model", stripProviderPrefix(opts.model));
    args.push("--max-turns", String(opts.maxTurns));

    if (opts.systemPrompt) {
      args.push("--append-system-prompt", opts.systemPrompt);
    }

    if (opts.sessionId) {
      args.push("--resume", opts.sessionId);
    }

    return args;
  },
  parseNdjsonEvent(event) {
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
      return { contentDelta: event.delta.text };
    }

    if (event.type === "result") {
      return { resultText: typeof event.result === "string" ? event.result : typeof event.text === "string" ? event.text : "" };
    }

    return {};
  },
};

function createScaffoldBackend(kind: Exclude<AgentKind, "claude">, label: string, defaultBinary: string): AgentBackend {
  return {
    kind,
    label,
    summary: `${label} backend scaffold. Config and model wiring exist, but runtime spawning and parsing are not implemented yet.`,
    implementationStatus: "scaffold",
    defaultBinary,
    defaultModel: `${kind}-default`,
    models: [makeScaffoldModel(kind, label)],
    sanitizeEnv(env) {
      return { ...env };
    },
    buildArgs() {
      throw new Error(`${label} backend is scaffold-only. Set "agentKind" to "claude" or implement the ${kind} adapter.`);
    },
    parseNdjsonEvent() {
      return {};
    },
  };
}

export const AGENT_BACKENDS: Record<AgentKind, AgentBackend> = {
  claude: claudeBackend,
  opencode: createScaffoldBackend("opencode", "OpenCode CLI", "opencode"),
  codex: createScaffoldBackend("codex", "Codex CLI", "codex"),
  amux: createScaffoldBackend("amux", "amux CLI", "amux"),
};

export function getAgentBackend(kind?: string | null): AgentBackend {
  if (kind === "opencode" || kind === "codex" || kind === "amux" || kind === "claude") {
    return AGENT_BACKENDS[kind];
  }
  return AGENT_BACKENDS.claude;
}
