#!/bin/bash
set -e

EXT_DIR="${OPENCLAW_EXTENSIONS:-$HOME/.openclaw/extensions}/terminal-agent-runner"

echo "Installing openclaw-terminal-ai-runner to $EXT_DIR ..."
mkdir -p "$EXT_DIR/src"

cp index.ts "$EXT_DIR/"
cp src/terminal-agent-bridge.ts "$EXT_DIR/src/"
cp openclaw.plugin.json "$EXT_DIR/"
cp package.json "$EXT_DIR/"

# Create config.json from example if it doesn't exist
if [ ! -f "$EXT_DIR/config.json" ]; then
  cp config.example.json "$EXT_DIR/config.json"
  echo "Created default config at $EXT_DIR/config.json"
else
  echo "Existing config.json preserved at $EXT_DIR/config.json"
fi

# Detect default Claude-compatible binary
AGENT_BIN=$(command -v claude 2>/dev/null || echo "")
if [ -z "$AGENT_BIN" ]; then
  echo ""
  echo "WARNING: 'claude' not found in PATH."
  echo "Install it: npm i -g @anthropic-ai/claude-code"
  echo "Then set the full path in $EXT_DIR/config.json"
else
  echo "Found default agent binary at: $AGENT_BIN"
fi

# Configure OpenClaw via CLI
echo ""
echo "Configuring OpenClaw..."

# Enable the plugin
openclaw plugins enable terminal-agent-runner 2>/dev/null && echo "Plugin enabled." || \
  npx openclaw plugins enable terminal-agent-runner 2>/dev/null && echo "Plugin enabled." || \
  echo "Could not auto-enable plugin. Run: openclaw plugins enable terminal-agent-runner"

# Register the provider
openclaw config set models.providers.terminal-agent-runner.baseUrl "http://127.0.0.1:7779/v1" 2>/dev/null || \
  npx openclaw config set models.providers.terminal-agent-runner.baseUrl "http://127.0.0.1:7779/v1" 2>/dev/null || true
openclaw config set models.providers.terminal-agent-runner.api "openai-completions" 2>/dev/null || \
  npx openclaw config set models.providers.terminal-agent-runner.api "openai-completions" 2>/dev/null || true
openclaw config set models.providers.terminal-agent-runner.apiKey "terminal-agent-runner-local" 2>/dev/null || \
  npx openclaw config set models.providers.terminal-agent-runner.apiKey "terminal-agent-runner-local" 2>/dev/null || true
openclaw config set models.providers.terminal-agent-runner.authHeader false 2>/dev/null || \
  npx openclaw config set models.providers.terminal-agent-runner.authHeader false 2>/dev/null || true

echo "Provider configured."

echo ""
echo "Done! Remaining steps:"
echo ""
echo "  1. Authenticate the configured terminal agent CLI."
echo "     Current default example: claude login"
echo ""
echo "  2. Restart OpenClaw gateway:"
echo "     openclaw gateway restart"
echo ""
if [ -z "$AGENT_BIN" ]; then
  echo "  3. Set agentBin in $EXT_DIR/config.json"
  echo ""
fi
