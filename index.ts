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
import { getAgentBackend } from "./src/agent-backends.js";
import { startBridgeServer, stopBridgeServer } from "./src/terminal-agent-bridge.js";

const PROVIDER_ID = "terminal-agent-runner";
const LEGACY_PROVIDER_ID = "claude-runner";
const DEFAULT_PORT = 7779;
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

let bridgeServer: Awaited<ReturnType<typeof startBridgeServer>> | null = null;

const terminalAgentRunnerPlugin = {
  id: PROVIDER_ID,
  name: "Terminal Agent Runner",
  description: `Terminal agent runner for ${TARGET_AGENT_FAMILY}`,

  register(api: OpenClawPluginApi) {
    const extConfig = loadExtensionConfig();
    const backend = getAgentBackend(extConfig.agentKind as string | undefined);
    const providerModels = backend.models.map((model) => ({ ...model, api: "openai-completions" as const }));
    const agentBin = (extConfig.agentBin as string) ?? (extConfig.claudeBin as string) ?? backend.defaultBinary;
    const port = (extConfig.port as number) ?? DEFAULT_PORT;
    const skipPermissions = (extConfig.skipPermissions as boolean) ?? true;
    const defaultModel = (extConfig.defaultModel as string) ?? backend.defaultModel;
    const maxTurns = (extConfig.maxTurns as number) ?? 30;
    const backendRuntimeNote =
      backend.implementationStatus === "implemented"
        ? `${backend.label} backend is active. ${backend.summary}`
        : `${backend.label} backend is scaffold-only in this fork. Requests will fail until its adapter is implemented.`;

    api.registerService({
      id: "terminal-agent-runner-bridge",
      start: async (ctx) => {
        const rawWorkDir = (extConfig.workDir as string) ?? ctx.workspaceDir ?? DEFAULT_WORK_DIR;
        const workDir = rawWorkDir.startsWith("~") ? rawWorkDir.replace("~", homedir()) : rawWorkDir;
        bridgeServer = await startBridgeServer({ agentKind: backend.kind, port, agentBin, skipPermissions, workDir, maxTurns });
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
          label: `Local ${backend.label}`,
          hint: `${backend.summary} Fork target: ${TARGET_AGENT_FAMILY}`,
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const bridgePort = await ctx.prompter.text({
              message: "Bridge server port",
              initialValue: String(port),
              validate: (v: string) => {
                const n = parseInt(v, 10);
                return n > 0 && n < 65536 ? undefined : "Enter a valid port";
              },
            });

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
                      models: providerModels,
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: Object.fromEntries(backend.models.map((model) => [`${PROVIDER_ID}/${model.id}`, {}])),
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
                `Set "agentKind": "${backend.kind}" and "agentBin": "${agentBin}" in the extension config.json when changing backends.`,
                backendRuntimeNote,
                ...(backend.kind === "claude"
                  ? ["Claude backend requires an active Anthropic Max subscription for --dangerously-skip-permissions."]
                  : []),
              ],
            };
          },
        },
      ],
      discovery: {
        order: "late",
        run: async (ctx: ProviderDiscoveryContext) => {
          const explicit = ctx.config.models?.providers?.[PROVIDER_ID] ?? ctx.config.models?.providers?.[LEGACY_PROVIDER_ID];
          if (explicit) {
            return {
              provider: {
                ...explicit,
                baseUrl: explicit.baseUrl ?? `http://127.0.0.1:${port}/v1`,
                api: explicit.api ?? ("openai-completions" as const),
                apiKey: explicit.apiKey ?? "terminal-agent-runner-local",
                authHeader: false,
                models: Array.isArray(explicit.models) && explicit.models.length > 0 ? explicit.models : providerModels,
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
                models: providerModels,
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
          choiceHint: `${backend.label} selected. Fork target: ${TARGET_AGENT_FAMILY}`,
          groupId: PROVIDER_ID,
          groupLabel: "Terminal Agent CLI",
          groupHint: backendRuntimeNote,
          methodId: "local",
        },
        modelPicker: {
          label: "Terminal Agent CLI",
          hint: `Current backend: ${backend.label}`,
          methodId: "local",
        },
      },
    });
  },
};

export default terminalAgentRunnerPlugin;
