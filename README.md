# openclaw-terminal-ai-runner

OpenClaw extension that routes LLM requests through terminal agent CLIs instead of direct API calls. This fork is aimed at `claude code, opencode, codex cli, amux`.

Today the bridge still ships with Claude-compatible defaults: it spawns a local CLI subprocess, expects `stream-json` output, and translates that stream back into OpenAI-compatible SSE for OpenClaw. The rename gives this fork a cleaner base for expanding toward a more agent-agnostic terminal runner.

## How it works

```text
Request -> OpenClaw Gateway -> terminal-agent-runner provider
  -> bridge server (OpenAI-compat on localhost:7779)
    -> spawn configured terminal agent binary
      -> NDJSON -> SSE translation -> back to OpenClaw
```

The extension registers as an OpenClaw LLM provider. When the gateway sends a chat completion request, the bridge spawns the configured terminal agent binary, parses streaming NDJSON output, and translates it back into OpenAI-compatible SSE chunks.

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- A terminal agent CLI installed. Target family: `claude code, opencode, codex cli, amux`
- Current default examples assume Anthropic's `claude` binary is installed (`npm i -g @anthropic-ai/claude-code`)
- Anthropic Max subscription (required for `--dangerously-skip-permissions` in headless mode)

## Install

```bash
git clone git@github.com:realagiorganization/openclaw-terminal-ai-runner.git
cd openclaw-terminal-ai-runner
bash install.sh
```

The install script:
- Copies the extension to `~/.openclaw/extensions/terminal-agent-runner/`
- Enables the plugin via `openclaw plugins enable`
- Registers the provider via `openclaw config set`
- Creates a default `config.json` if one doesn't exist

After install, two remaining steps:

```bash
# 1. Authenticate the configured terminal agent CLI
#    Current default examples use Claude-compatible auth
claude login

# 2. Restart the gateway to pick up the extension
openclaw gateway restart
```

## Current backend status

This rename is ahead of the full multi-agent implementation. The first supported backend remains Claude-compatible, and the current bridge still assumes Claude-style flags such as `--output-format stream-json`, `--max-turns`, `--append-system-prompt`, and `--resume`.

## Configuration

Extension settings are in `~/.openclaw/extensions/terminal-agent-runner/config.json`:

| Option | Default | Description |
|---|---|---|
| `agentBin` | `"claude"` | Path to the terminal agent binary. Current defaults assume a Claude-compatible CLI |
| `claudeBin` | unset | Legacy compatibility alias for older config files |
| `port` | `7779` | Port for the local bridge server |
| `skipPermissions` | `true` | Use `--dangerously-skip-permissions` flag (requires Max plan) |
| `maxTurns` | `30` | Max agentic turns per request (safety cap to prevent runaway loops) |
| `defaultModel` | `"claude-opus-4-5"` | Default model when none specified |
| `workDir` | `"~/.openclaw/workspace"` | Working directory for the terminal agent CLI |

To set as default model (optional):

```bash
openclaw config set agents.defaults.model.primary "terminal-agent-runner/claude-opus-4-5"
openclaw config set agents.defaults.model.fallbacks '["anthropic/claude-opus-4-5"]'
```

## Available models

| Model ID | Description |
|---|---|
| `terminal-agent-runner/claude-opus-4-5` | Claude Opus 4.5 via CLI |
| `terminal-agent-runner/claude-sonnet-4-6` | Claude Sonnet 4.6 via CLI |
| `terminal-agent-runner/claude-sonnet-4` | Claude Sonnet 4 via CLI |
| `terminal-agent-runner/claude-haiku-4-5` | Claude Haiku 4.5 via CLI |

## Why use this instead of the Anthropic API directly?

| | API (per-token) | CLI (this extension) |
|---|---|---|
| **Billing** | Pay per token | Max plan flat rate |
| **Capabilities** | Chat completions only | Terminal agent workflow for `claude code, opencode, codex cli, amux` |
| **Reasoning** | Single-turn | Multi-step agentic loops |
| **Tool handling** | Build your own | Delegated to CLI |

## Updating

Pull the latest version and re-run install:

```bash
cd openclaw-terminal-ai-runner
git pull
bash install.sh
```

Your `config.json` is preserved across updates.

## Troubleshooting

**Gateway crashes with "Unrecognized keys" error**

The `plugins.entries.terminal-agent-runner` section in `openclaw.json` must only contain `{ "enabled": true }`. All extension settings go in the extension's own `config.json`, not in `openclaw.json`.

**"Invalid API key" or "Please run /login"**

The configured terminal agent CLI is not authenticated. For Claude-compatible defaults, run `claude login` on the server.

**Bridge not responding**

Check if the bridge is running: `curl http://127.0.0.1:7779/health`

If not, check gateway logs: `journalctl --user -u openclaw-gateway -n 50`

**Terminal agent binary not found**

Set the full path in `config.json`: `"agentBin": "/home/user/.npm-global/bin/claude"`

## License

MIT
