/**
 * Terminal Agent CLI Bridge Server
 *
 * Embeds a tiny HTTP server that speaks OpenAI chat completions protocol.
 * When OpenClaw sends a request, it spawns the configured terminal agent
 * binary and translates NDJSON streaming output into SSE chunks.
 *
 * The first backend remains Claude-compatible, so this bridge still assumes
 * stream-json output and Claude-style flags while the fork grows toward
 * broader terminal-agent support.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";

export interface BridgeConfig {
  port: number;
  agentBin: string;
  skipPermissions: boolean;
  workDir: string;
  maxTurns?: number;
  maxRetries?: number;
}

interface LiveProcess {
  proc: ChildProcess;
  abortReason?: string;
}

const DEFAULT_MAX_TURNS = 30;
const MAX_RETRIES = 2;
const RETRY_DELAYS = [1000, 2000];
const KILL_ESCALATION_MS = 2000;

const liveProcesses = new Map<string, LiveProcess>();

function buildCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDECODE") || key.startsWith("CLAUDE_CODE_")) {
      delete env[key];
    }
  }
  return env;
}

const TRANSIENT_PATTERNS = [
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /503/,
  /529/,
  /rate.?limit/i,
  /overloaded/i,
  /too many requests/i,
];

function isTransientError(stderr: string, code: number | null): boolean {
  if (code === null) return false;
  return TRANSIENT_PATTERNS.some((p) => p.test(stderr));
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return String(content);
}

const PROMPT_HISTORY_MAX_MESSAGES = 24;
const PROMPT_HISTORY_MAX_CHARS = 48_000;

function formatRoleLabel(role: string): string {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "tool":
      return "Tool";
    case "system":
      return "System";
    default:
      return role[0]?.toUpperCase() + role.slice(1);
  }
}

function trimPromptHistory(text: string, maxChars = PROMPT_HISTORY_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return `[Earlier conversation truncated]\n\n${text.slice(-maxChars)}`;
}

function extractPromptFromMessages(messages: Array<{ role: string; content: unknown }>): string {
  const conversational = messages
    .filter((m) => m.role !== "system")
    .slice(-PROMPT_HISTORY_MAX_MESSAGES)
    .map((m) => {
      const content = flattenContent(m.content).trim();
      if (!content) return "";
      return `${formatRoleLabel(m.role)}:\n${content}`;
    })
    .filter(Boolean)
    .join("\n\n");

  return trimPromptHistory(conversational);
}

function extractSystemPrompt(messages: Array<{ role: string; content: unknown }>): string | undefined {
  const systemMsgs = messages.filter((m) => m.role === "system");
  if (systemMsgs.length === 0) return undefined;
  const full = systemMsgs.map((m) => flattenContent(m.content)).filter(Boolean).join("\n\n");
  return full || undefined;
}

class NdjsonParser {
  private buffer = "";
  private handler: (event: { type: string; [key: string]: any }) => void;

  constructor(handler: (event: { type: string; [key: string]: any }) => void) {
    this.handler = handler;
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event.type) this.handler(event);
      } catch {
        // Ignore malformed lines
      }
    }
  }

  flush(): void {
    if (this.buffer.trim()) {
      try {
        const event = JSON.parse(this.buffer.trim());
        if (event.type) this.handler(event);
      } catch {
        // Ignore trailing incomplete data
      }
    }
    this.buffer = "";
  }
}

function killProcess(id: string): void {
  const live = liveProcesses.get(id);
  if (!live) return;
  live.abortReason = "killed";

  try {
    if (live.proc.pid) process.kill(-live.proc.pid, "SIGTERM");
  } catch {
    live.proc.kill("SIGTERM");
  }

  setTimeout(() => {
    if (liveProcesses.has(id)) {
      try {
        if (live.proc.pid) process.kill(-live.proc.pid, "SIGKILL");
      } catch {
        live.proc.kill("SIGKILL");
      }
    }
  }, KILL_ESCALATION_MS);
}

interface SpawnOpts {
  prompt: string;
  model: string;
  systemPrompt?: string;
  sessionId?: string;
  config: BridgeConfig;
}

function normalizeModel(model: string): string {
  return model.replace(/^(?:terminal-agent-runner|claude-runner)\//, "");
}

function buildArgs(opts: SpawnOpts): string[] {
  const args: string[] = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose"];

  if (opts.config.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  args.push("--model", normalizeModel(opts.model));

  const maxTurns = opts.config.maxTurns ?? DEFAULT_MAX_TURNS;
  args.push("--max-turns", String(maxTurns));

  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }

  if (opts.sessionId) {
    args.push("--resume", opts.sessionId);
  }

  return args;
}

async function handleCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  config: BridgeConfig,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());

  const messages: Array<{ role: string; content: string }> = body.messages ?? [];
  const stream = body.stream !== false;
  const model = body.model ?? "claude-opus-4-5";
  const sessionId = (req.headers["x-session-id"] as string) || undefined;
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const prompt = extractPromptFromMessages(messages);
  const systemPrompt = extractSystemPrompt(messages);

  if (!prompt) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "No user message found", type: "invalid_request_error" } }));
    return;
  }

  const spawnOpts: SpawnOpts = { prompt, model, systemPrompt, sessionId, config };
  const maxRetries = config.maxRetries ?? MAX_RETRIES;
  let lastError = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS[attempt - 1] ?? 2000;
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      if (stream) {
        await handleStreamingResponse(spawnOpts, res, requestId);
      } else {
        await handleNonStreamingResponse(spawnOpts, res, requestId);
      }
      return;
    } catch (err: any) {
      lastError = err.stderr ?? err.message ?? String(err);

      if (res.headersSent) return;

      if (!isTransientError(lastError, err.exitCode ?? null)) {
        break;
      }
    }
  }

  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: lastError || "terminal agent CLI failed after retries", type: "server_error" } }));
  }
}

async function handleStreamingResponse(
  opts: SpawnOpts,
  res: ServerResponse,
  requestId: string,
): Promise<void> {
  const args = buildArgs(opts);
  const cleanEnv = buildCleanEnv();
  const model = normalizeModel(opts.model);

  const proc = spawn(opts.config.agentBin, args, {
    cwd: opts.config.workDir,
    env: cleanEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  liveProcesses.set(requestId, { proc });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sendSSE = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendSSE({
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  });

  let resultText = "";
  let stderr = "";

  const parser = new NdjsonParser((event) => {
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
      sendSSE({
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
      });
    } else if (event.type === "result") {
      resultText = event.result ?? event.text ?? "";
    }
  });

  proc.stdout!.on("data", (chunk: Buffer) => {
    parser.feed(chunk.toString());
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise<void>((resolve, reject) => {
    proc.on("close", () => {
      parser.flush();
      liveProcesses.delete(requestId);

      if (resultText && !res.writableEnded) {
        sendSSE({
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: resultText }, finish_reason: null }],
        });
      }

      sendSSE({
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      res.write("data: [DONE]\n\n");
      res.end();
      resolve();
    });

    proc.on("error", (err) => {
      liveProcesses.delete(requestId);
      if (!res.headersSent) {
        const wrapped: any = new Error(err.message);
        wrapped.stderr = stderr;
        reject(wrapped);
      } else {
        sendSSE({
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: `\n\nError: ${err.message}` }, finish_reason: "stop" }],
        });
        res.write("data: [DONE]\n\n");
        res.end();
        resolve();
      }
    });
  });
}

async function handleNonStreamingResponse(
  opts: SpawnOpts,
  res: ServerResponse,
  requestId: string,
): Promise<void> {
  const args = buildArgs(opts);
  const cleanEnv = buildCleanEnv();
  const model = normalizeModel(opts.model);

  const proc = spawn(opts.config.agentBin, args, {
    cwd: opts.config.workDir,
    env: cleanEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  liveProcesses.set(requestId, { proc });

  let resultText = "";
  let stderr = "";

  const parser = new NdjsonParser((event) => {
    if (event.type === "result") {
      resultText = event.result ?? event.text ?? "";
    }
  });

  proc.stdout!.on("data", (chunk: Buffer) => {
    parser.feed(chunk.toString());
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise<void>((resolve, reject) => {
    proc.on("close", (code) => {
      parser.flush();
      liveProcesses.delete(requestId);

      if (!resultText && code !== 0) {
        const wrapped: any = new Error(stderr || `terminal agent exited with code ${code}`);
        wrapped.exitCode = code;
        wrapped.stderr = stderr;
        reject(wrapped);
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: requestId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: resultText },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
      );
      resolve();
    });

    proc.on("error", (err) => {
      liveProcesses.delete(requestId);
      const wrapped: any = new Error(err.message);
      wrapped.stderr = stderr;
      reject(wrapped);
    });
  });
}

export function startBridgeServer(config: BridgeConfig): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === "/health" || req.url === "/v1/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", liveProcesses: liveProcesses.size }));
        return;
      }

      if (req.url === "/v1/models" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "claude-opus-4-5", object: "model", owned_by: "anthropic" },
              { id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic" },
              { id: "claude-sonnet-4", object: "model", owned_by: "anthropic" },
              { id: "claude-haiku-4-5", object: "model", owned_by: "anthropic" },
            ],
          }),
        );
        return;
      }

      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        try {
          await handleCompletions(req, res, config);
        } catch (err: any) {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: err.message, type: "server_error" } }));
          }
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }));
    });

    server.listen(config.port, "127.0.0.1", () => {
      resolve(server);
    });

    server.on("error", reject);
  });
}

export function stopBridgeServer(server: ReturnType<typeof createServer>): Promise<void> {
  for (const [id] of liveProcesses) {
    killProcess(id);
  }
  liveProcesses.clear();

  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
