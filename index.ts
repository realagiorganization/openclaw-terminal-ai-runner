/**
 * OpenClaw Terminal Agent Runner Extension
 *
 * Registers "terminal-agent-runner" as an LLM provider that spawns a
 * terminal agent CLI as a subprocess. This fork is oriented toward
 * claude code, opencode, codex cli, amux while the first backend remains
 * Claude-compatible.
 *
 * Architecture:
 *   OpenClaw Gateway -> provider: "terminal-agent-runner"
 *     -> embedded bridge server (OpenAI-compat on localhost)
 *       -> spawn configured agent binary
 *         -> NDJSON -> SSE translation -> back to OpenClaw
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderAuthResult,
  ProviderDiscoveryContext,
} from "openclaw/plugin-sdk/core";
import { startBridgeServer, stopBridgeServer } from "./src/terminal-agent-bridge.js";

const PROVIDER_ID = "terminal-agent-runner";
const LEGACY_PROVIDER_ID = "claude-runner";
const DEFAULT_PORT = 7779;
const DEFAULT_AGENT_BIN = "claude";
const DEFAULT_WORK_DIR = "~/.openclaw/workspace";
const TARGET_AGENT_FAMILY = "claude code, opencode, codex cli, amux";

function loadExtensionConfig(): Record<string, unknown> {
  try {
    const extDir = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(extDir, "config.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const MODELS = [
  {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5 (CLI)",
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (CLI)",
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4 (CLI)",
    reasoning: false,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5 (CLI)",
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
];

let bridgeServer: Awaited<ReturnType<typeof startBridgeServer>> | null = null;

const terminalAgentRunnerPlugin = {
  id: PROVIDER_ID,
  name: "Terminal Agent Runner",
  description: `Terminal agent runner for ${TARGET_AGENT_FAMILY}`,

  register(api: OpenClawPluginApi) {
    const extConfig = loadExtensionConfig();
    const agentBin = (extConfig.agentBin as string) ?? (extConfig.claudeBin as string) ?? DEFAULT_AGENT_BIN;
    const port = (extConfig.port as number) ?? DEFAULT_PORT;
    const skipPermissions = (extConfig.skipPermissions as boolean) ?? true;
    const defaultModel = (extConfig.defaultModel as string) ?? "claude-opus-4-5";
    const maxTurns = (extConfig.maxTurns as number) ?? 30;

    api.registerService({
      id: "terminal-agent-runner-bridge",
      start: async (ctx) => {
        const rawWorkDir = (extConfig.workDir as string) ?? ctx.workspaceDir ?? DEFAULT_WORK_DIR;
        const workDir = rawWorkDir.startsWith("~") ? rawWorkDir.replace("~", homedir()) : rawWorkDir;
        bridgeServer = await startBridgeServer({ port, agentBin, skipPermissions, workDir, maxTurns });
        ctx.logger.info(`Terminal Agent Runner bridge listening on 127.0.0.1:${port}`);
      },
      stop: async (ctx) => {
        if (bridgeServer) {
          await stopBridgeServer(bridgeServer);
          bridgeServer = null;
          ctx.logger.info("Terminal Agent Runner bridge stopped");
        }
      },
    });

    api.registerProvider({
      id: PROVIDER_ID,
      label: "Terminal Agent CLI",
      docsPath: "/providers/models",
      auth: [
        {
          id: "local",
          label: "Local Terminal Agent CLI",
          hint: `Targets ${TARGET_AGENT_FAMILY}. Current defaults expect Claude-compatible flags and stream-json output.`,
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const agentBinary = await ctx.prompter.text({
              message: "Path to terminal agent binary",
              initialValue: agentBin,
              validate: (v: string) => (v.trim() ? undefined : "Path is required"),
            });

            const bridgePort = await ctx.prompter.text({
              message: "Bridge server port",
              initialValue: String(port),
              validate: (v: string) => {
                const n = parseInt(v, 10);
                return n > 0 && n < 65536 ? undefined : "Enter a valid port";
              },
            });

            void agentBinary;
            const baseUrl = `http://127.0.0.1:${bridgePort}/v1`;

            return {
              profiles: [
                {
                  profileId: `${PROVIDER_ID}:default`,
                  credential: {
                    type: "api_key",
                    provider: PROVIDER_ID,
                    key: "terminal-agent-runner-local",
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl,
                      apiKey: "terminal-agent-runner-local",
                      api: "openai-completions",
                      authHeader: false,
                      models: MODELS.map((m) => ({ ...m, api: "openai-completions" as const })),
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: Object.fromEntries(MODELS.map((m) => [`${PROVIDER_ID}/${m.id}`, {}])),
                  },
                },
                plugins: {
                  entries: {
                    [PROVIDER_ID]: {
                      enabled: true,
                    },
                  },
                },
              },
              defaultModel: `${PROVIDER_ID}/${defaultModel}`,
              notes: [
                `This fork is targeting ${TARGET_AGENT_FAMILY}.`,
                "Current runtime defaults still expect a Claude-compatible CLI (npm i -g @anthropic-ai/claude-code).",
                "Requires an active Anthropic Max subscription for --dangerously-skip-permissions.",
                "All reasoning, tool use, and file editing is handled by the CLI - zero cost per token on Max plan.",
              ],
            };
          },
        },
      ],
      discovery: {
        order: "late",
        run: async (ctx: ProviderDiscoveryContext) => {
          const explicit = ctx.config.models?.providers?.[PROVIDER_ID] ?? ctx.config.models?.providers?.[LEGACY_PROVIDER_ID];
          if (explicit && Array.isArray(explicit.models) && explicit.models.length > 0) {
            return {
              provider: {
                ...explicit,
                baseUrl: explicit.baseUrl ?? `http://127.0.0.1:${port}/v1`,
                api: explicit.api ?? ("openai-completions" as const),
                apiKey: explicit.apiKey ?? "terminal-agent-runner-local",
                authHeader: false,
              },
            };
          }

          const pluginEnabled = ctx.config.plugins?.entries?.[PROVIDER_ID] ?? ctx.config.plugins?.entries?.[LEGACY_PROVIDER_ID];
          if (pluginEnabled) {
            return {
              provider: {
                baseUrl: `http://127.0.0.1:${port}/v1`,
                api: "openai-completions" as const,
                apiKey: "terminal-agent-runner-local",
                authHeader: false,
                models: MODELS.map((m) => ({ ...m, api: "openai-completions" as const })),
              },
            };
          }

          return null;
        },
      },
      wizard: {
        onboarding: {
          choiceId: PROVIDER_ID,
          choiceLabel: "Terminal Agent CLI",
          choiceHint: `Agnostic terminal-agent fork for ${TARGET_AGENT_FAMILY}`,
          groupId: PROVIDER_ID,
          groupLabel: "Terminal Agent CLI",
          groupHint: "Current backend defaults remain Claude-compatible while this fork expands to more terminal agents",
          methodId: "local",
        },
        modelPicker: {
          label: "Terminal Agent CLI",
          hint: `Use the terminal agent runner for ${TARGET_AGENT_FAMILY}`,
          methodId: "local",
        },
      },
    });
  },
};

export default terminalAgentRunnerPlugin;
