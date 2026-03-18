# openclaw-claude-runner

OpenClaw extension that routes LLM requests through [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) instead of API calls.

Instead of paying per-token via the Anthropic API, this spawns the `claude` CLI binary as a subprocess — giving you full agentic capabilities (tool use, file editing, multi-step reasoning, MCP servers, memory) at Anthropic Max plan flat-rate pricing.

## How it works

```
Request → OpenClaw Gateway → claude-runner provider
  → bridge server (OpenAI-compat on localhost:7779)
    → spawn `claude -p "..." --output-format stream-json`
      → NDJSON → SSE translation → back to OpenClaw
```

The extension registers as an OpenClaw LLM provider. When the gateway sends a chat completion request, the bridge spawns `claude` CLI, parses its streaming NDJSON output, and translates it back into OpenAI-compatible SSE chunks.

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed (`npm i -g @anthropic-ai/claude-code`)
- Anthropic Max subscription (required for `--dangerously-skip-permissions` in headless mode)

## Install

```bash
git clone https://github.com/siimvene/openclaw-claude-runner.git
cd openclaw-claude-runner
bash install.sh
```

The install script:
- Copies the extension to `~/.openclaw/extensions/claude-runner/`
- Enables the plugin via `openclaw plugins enable`
- Registers the provider via `openclaw config set`
- Creates a default `config.json` if one doesn't exist

After install, two remaining steps:

```bash
# 1. Authenticate Claude Code CLI (if not already done)
claude login

# 2. Restart the gateway to pick up the extension
openclaw gateway restart
```

## Configuration

Extension settings are in `~/.openclaw/extensions/claude-runner/config.json`:

| Option | Default | Description |
|---|---|---|
| `claudeBin` | `"claude"` | Path to claude binary. Use full path if not in PATH (e.g., `/home/user/.npm-global/bin/claude`) |
| `port` | `7779` | Port for the local bridge server |
| `skipPermissions` | `true` | Use `--dangerously-skip-permissions` flag (requires Max plan) |
| `maxTurns` | `30` | Max agentic turns per request (safety cap to prevent runaway loops) |
| `defaultModel` | `"claude-opus-4-5"` | Default model when none specified |
| `workDir` | `"~/.openclaw/workspace"` | Working directory for claude CLI |

To set as default model (optional):

```bash
openclaw config set agents.defaults.model.primary "claude-runner/claude-opus-4-5"
openclaw config set agents.defaults.model.fallbacks '["anthropic/claude-opus-4-5"]'
```

## Available models

| Model ID | Description |
|---|---|
| `claude-runner/claude-opus-4-5` | Claude Opus 4.5 via CLI |
| `claude-runner/claude-sonnet-4-6` | Claude Sonnet 4.6 via CLI |
| `claude-runner/claude-sonnet-4` | Claude Sonnet 4 via CLI |
| `claude-runner/claude-haiku-4-5` | Claude Haiku 4.5 via CLI |

## Why use this instead of the Anthropic API directly?

| | API (per-token) | CLI (this extension) |
|---|---|---|
| **Billing** | Pay per token | Max plan flat rate |
| **Capabilities** | Chat completions only | Full Claude Code: tool use, file editing, MCP, memory |
| **Reasoning** | Single-turn | Multi-step agentic loops |
| **Tool handling** | Build your own | Delegated to CLI |

## Updating

Pull the latest version and re-run install:

```bash
cd openclaw-claude-runner
git pull
bash install.sh
```

Your `config.json` is preserved across updates.

## Troubleshooting

**Gateway crashes with "Unrecognized keys" error**

The `plugins.entries.claude-runner` section in `openclaw.json` must only contain `{ "enabled": true }`. All extension settings go in the extension's own `config.json`, not in `openclaw.json`.

**"Invalid API key" or "Please run /login"**

Claude CLI is not authenticated. Run `claude login` on the server.

**Bridge not responding**

Check if the bridge is running: `curl http://127.0.0.1:7779/health`

If not, check gateway logs: `journalctl --user -u openclaw-gateway -n 50`

**Claude binary not found**

Set the full path in `config.json`: `"claudeBin": "/home/user/.npm-global/bin/claude"`

## License

MIT
