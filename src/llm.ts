export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatOptions {
  provider: { kind: "ollama" | "openai"; baseUrl: string; apiKey?: string };
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage?: { input?: number; output?: number };
}

function endpoint(kind: "ollama" | "openai", baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return kind === "ollama" ? `${base}/api/chat` : `${base}/chat/completions`;
}

async function readLine(body: ReadableStream<Uint8Array>, onLine: (line: string) => void, signal?: AbortSignal): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) onLine(line);
      }
    }
    const tail = buffer.trim();
    if (tail) onLine(tail);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* noop */
    }
  }
  return buffer;
}

/** Extract top-level JSON objects from raw text using bracket matching. */
function extractJsonObjects(text: string): unknown[] {
  const results: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") { i++; continue; }
    const start = i;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (c === "\\" && inStr) { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      if (c === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end >= 0) {
      try { results.push(JSON.parse(text.slice(start, end + 1))); } catch { /* skip */ }
      i = end + 1;
    } else {
      i = start + 1;
    }
  }
  return results;
}

/** Parse tool calls from model text — handles both fenced code blocks and bare JSON. */
function parseFallback(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  // 1. Try fenced code blocks
  for (const match of text.matchAll(/```(?:tool|tool_call|json)\s*([\s\S]*?)```/gi)) {
    for (const obj of extractJsonObjects(match[1])) {
      const item = obj as Record<string, unknown>;
      if (item && typeof item.name === "string") {
        calls.push({ id: `call_${calls.length + 1}`, name: item.name, arguments: (item.arguments ?? item.input ?? {}) as Record<string, unknown> });
      }
    }
  }
  if (calls.length) return calls;
  // 2. Try bare JSON objects — for models that output raw JSON instead of using native tool calling
  for (const obj of extractJsonObjects(text)) {
    const item = obj as Record<string, unknown>;
    if (item && typeof item.name === "string" && (item.arguments !== undefined || item.input !== undefined)) {
      calls.push({ id: `call_${calls.length + 1}`, name: item.name, arguments: (item.arguments ?? item.input ?? {}) as Record<string, unknown> });
    }
  }
  return calls;
}

/** Remove bare JSON tool-call objects from text so the UI doesn't display raw JSON. */
function stripToolCallJson(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "{") {
      const start = i;
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let j = i; j < text.length; j++) {
        const c = text[j];
        if (esc) { esc = false; continue; }
        if (c === "\\" && inStr) { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === "{") depth++;
        if (c === "}") { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end >= 0) {
        try {
          const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
          if (obj && typeof obj.name === "string" && (obj.arguments !== undefined || obj.input !== undefined)) {
            i = end + 1; continue; // skip tool-call JSON
          }
        } catch { /* not valid JSON — keep it */ }
      }
      result += text[i]; i++;
    } else {
      result += text[i]; i++;
    }
  }
  return result.trim();
}

/** Wrap tool specs in the OpenAI-compatible function-calling envelope (works for both Ollama and OpenAI). */
function wrapTools(specs: ToolSpec[]): object[] {
  return specs.map((s) => ({ type: "function", function: { name: s.name, description: s.description, parameters: s.parameters } }));
}

/** Map of common tool name variants to canonical names. Local models often use camelCase or other conventions. */
const TOOL_ALIASES: Record<string, string> = {
  readFile: "read_file", read: "read_file", file_read: "read_file", readfile: "read_file",
  writeFile: "write_file", write: "write_file", createFile: "write_file", create_file: "write_file", file_write: "write_file", writefile: "write_file", createfile: "write_file",
  editFile: "edit_file", edit: "edit_file", file_edit: "edit_file", modify_file: "edit_file", modifyFile: "edit_file", editfile: "edit_file", replaceInFile: "edit_file",
  listFiles: "list_files", list: "list_files", ls: "list_files", file_list: "list_files", listfiles: "list_files", listDir: "list_files",
  searchFiles: "search_files", grep: "search_files", find: "search_files", file_search: "search_files", searchfiles: "search_files",
  runCommand: "run_command", exec: "run_command", execute: "run_command", shell: "run_command", bash: "run_command", execute_command: "run_command", runcommand: "run_command", run_shell: "run_command",
  finishTool: "finish", finish_tool: "finish", done: "finish", complete: "finish", finishtool: "finish", task_complete: "finish",
};

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const { provider, model, messages, tools, temperature = 0.2, signal, onDelta } = opts;
  const res = await fetch(endpoint(provider.kind, provider.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature,
      messages: messages.map((m) => toWire(m, provider.kind)),
      ...(tools && tools.length ? { tools: wrapTools(tools) } : {}),
      ...(provider.kind === "openai" ? {} : { options: { num_ctx: 32768 } }),
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${provider.kind} ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 400)}` : ""}`);
  }

  let text = "";
  const calls: ToolCall[] = [];
  let usage: ChatResult["usage"];
  // Accumulator for OpenAI-style streaming tool calls (fragments arrive over multiple chunks)
  const pendingCalls = new Map<number, { id: string; name: string; args: string }>();

  const handle = (raw: string) => {
    const line = raw.startsWith("data:") ? raw.slice(5).trim() : raw;
    if (!line || line === "[DONE]") return;
    let chunk: any;
    try {
      chunk = JSON.parse(line);
    } catch {
      return;
    }
    if (chunk.error) throw new Error(String(chunk.error));
    if (provider.kind === "ollama") {
      const piece = chunk.message?.content ?? "";
      if (piece) {
        text += piece;
        onDelta?.(piece);
      }
      for (const call of chunk.message?.tool_calls ?? []) {
        const args = call.function?.arguments;
        calls.push({
          id: call.id ?? `call_${calls.length + 1}`,
          name: call.function?.name ?? call.name,
          arguments: typeof args === "string" ? safeJson(args) : args ?? {},
        });
      }
      if (chunk.done && chunk.prompt_eval_count) usage = { input: chunk.prompt_eval_count, output: chunk.eval_count };
      return;
    }
    // OpenAI-compatible streaming: accumulate tool_call fragments by index
    const choice = chunk.choices?.[0];
    const piece = choice?.delta?.content ?? "";
    if (piece) {
      text += piece;
      onDelta?.(piece);
    }
    for (const tc of choice?.delta?.tool_calls ?? []) {
      const idx: number = tc.index ?? pendingCalls.size;
      const existing = pendingCalls.get(idx);
      if (existing) {
        if (tc.function?.arguments) existing.args += tc.function.arguments;
        if (tc.function?.name) existing.name += tc.function.name;
      } else {
        pendingCalls.set(idx, {
          id: tc.id ?? `call_${idx}`,
          name: tc.function?.name ?? "",
          args: tc.function?.arguments ?? "",
        });
      }
    }
    if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
  };

  await readLine(res.body as ReadableStream<Uint8Array>, handle, signal);

  // Flush accumulated OpenAI streaming tool call fragments into final calls
  for (const [, pending] of pendingCalls) {
    if (pending.name) {
      calls.push({ id: pending.id, name: pending.name, arguments: safeJson(pending.args) });
    }
  }

  if (calls.length === 0) {
    calls.push(...parseFallback(text));
    if (calls.length) {
      text = text.replace(/```(?:tool|tool_call|json)[\s\S]*?```/gi, "");
      text = stripToolCallJson(text);
    }
  }

  // Normalize tool names — local models often use camelCase variants like readFile, writeFile, etc.
  for (const call of calls) {
    call.name = TOOL_ALIASES[call.name] ?? call.name;
  }

  return { text: text.trim(), toolCalls: calls, usage };
}

function safeJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function toWire(message: ChatMessage, kind: "ollama" | "openai"): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.tool_call_id, name: message.name };
  }
  if (message.role === "assistant" && message.tool_calls?.length) {
    return {
      role: "assistant",
      content: message.content || (kind === "openai" ? null : ""),
      tool_calls: message.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: kind === "openai" ? JSON.stringify(tc.arguments) : tc.arguments,
        },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

export async function listModels(kind: "ollama" | "openai", baseUrl: string, apiKey?: string, signal?: AbortSignal): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const url = kind === "ollama" ? `${base}/api/tags` : `${base}/models`;
  try {
    const res = await fetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: signal ?? AbortSignal.timeout(1500),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    const raw: string[] = kind === "ollama" ? (data.models ?? []).map((m: any) => m.name) : (data.data ?? []).map((m: any) => m.id);
    return raw.filter((m): m is string => typeof m === "string").sort();
  } catch {
    return [];
  }
}
