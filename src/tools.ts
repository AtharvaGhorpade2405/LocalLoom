import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { ToolSpec } from "./llm.js";

export interface ToolContext {
  cwd: string;
  emit: (line: string) => void;
}

export interface Tool {
  spec: ToolSpec;
  readonly: boolean;
  run: (args: any, ctx: ToolContext) => Promise<string> | string;
}

const MAX_LINES = 2000;

function within(cwd: string, target: string): string {
  const full = resolve(cwd, target);
  const root = resolve(cwd);
  if (full !== root && !full.startsWith(root)) throw new Error(`path escapes workspace: ${target}`);
  return full;
}

function trunc(text: string): string {
  const lines = text.split("\n");
  return lines.length > MAX_LINES ? `${lines.slice(0, MAX_LINES).join("\n")}\n... (${lines.length - MAX_LINES} more lines)` : text;
}

function walk(dir: string, cwd: string, out: string[], depth: number): void {
  if (out.length >= 800 || depth > 8) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    out.push(relative(cwd, full));
    if (entry.isDirectory()) walk(full, cwd, out, depth + 1);
  }
}

function grep(dir: string, cwd: string, re: RegExp, out: string[]): void {
  if (out.length >= 300) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= 300) return;
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      grep(full, cwd, re, out);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|kt|rb|php|c|h|cpp|css|html|ya?ml|toml|sql|sh)$/i.test(entry.name)) continue;
    try {
      readFileSync(full, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (re.test(line) && out.length < 300) out.push(`${relative(cwd, full)}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
    } catch {
      /* unreadable */
    }
  }
}

const str = (desc: string) => ({ type: "string", description: desc });

export const tools: Tool[] = [
  {
    readonly: true,
    spec: {
      name: "read_file",
      description: "Read a file from the workspace. Returns numbered lines.",
      parameters: {
        type: "object",
        properties: { filePath: str("path relative to workspace root"), offset: { type: "integer" }, limit: { type: "integer" } },
        required: ["filePath"],
      },
    },
    run: (args, ctx) => {
      const full = within(ctx.cwd, args.filePath);
      if (!existsSync(full)) return `error: ${args.filePath} does not exist`;
      const body = readFileSync(full, "utf8").split("\n");
      const start = Math.max(0, Number(args.offset ?? 1) - 1);
      const end = Math.min(body.length, start + Number(args.limit ?? 400));
      return body
        .slice(start, end)
        .map((line, i) => `${start + i + 1}: ${line}`)
        .join("\n");
    },
  },
  {
    readonly: true,
    spec: {
      name: "list_files",
      description: "List files in a directory (recursive, node_modules/.git skipped).",
      parameters: { type: "object", properties: { path: str("directory relative to workspace root, default '.'") } },
    },
    run: (args, ctx) => {
      const full = within(ctx.cwd, args.path ?? ".");
      if (!existsSync(full)) return `error: ${args.path} does not exist`;
      const out: string[] = [];
      walk(full, ctx.cwd, out, 0);
      return out.join("\n") || "(empty)";
    },
  },
  {
    readonly: true,
    spec: {
      name: "search_files",
      description: "Search file contents with a regular expression.",
      parameters: {
        type: "object",
        properties: { pattern: str("regular expression"), path: str("directory to search, default '.'") },
        required: ["pattern"],
      },
    },
    run: (args, ctx) => {
      const full = within(ctx.cwd, args.path ?? ".");
      const re = new RegExp(args.pattern, "i");
      const out: string[] = [];
      grep(full, ctx.cwd, re, out);
      return out.join("\n") || "(no matches)";
    },
  },
  {
    readonly: false,
    spec: {
      name: "write_file",
      description: "Create or overwrite a file with the given content.",
      parameters: {
        type: "object",
        properties: { filePath: str("path relative to workspace root"), content: str("full file content") },
        required: ["filePath", "content"],
      },
    },
    run: (args, ctx) => {
      const full = within(ctx.cwd, args.filePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, args.content ?? "");
      ctx.emit(`write ${args.filePath} (${(args.content ?? "").split("\n").length} lines)`);
      return `wrote ${args.filePath}`;
    },
  },
  {
    readonly: false,
    spec: {
      name: "edit_file",
      description: "Replace an exact string in an existing file.",
      parameters: {
        type: "object",
        properties: { filePath: str("path relative to workspace root"), old: str("exact text to replace"), newText: str("replacement text") },
        required: ["filePath", "old", "newText"],
      },
    },
    run: (args, ctx) => {
      const full = within(ctx.cwd, args.filePath);
      if (!existsSync(full)) return `error: ${args.filePath} does not exist`;
      const body = readFileSync(full, "utf8");
      if (!body.includes(args.old)) return `error: old text not found in ${args.filePath}`;
      writeFileSync(full, body.replace(args.old, args.newText));
      ctx.emit(`edit ${args.filePath}`);
      return `edited ${args.filePath}`;
    },
  },
  {
    readonly: false,
    spec: {
      name: "run_command",
      description: "Run a shell command in the workspace root. Returns stdout+stderr.",
      parameters: { type: "object", properties: { command: str("shell command") }, required: ["command"] },
    },
    run: (args, ctx) => {
      const res = spawnSync(args.command, {
        cwd: ctx.cwd,
        shell: true,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
      ctx.emit(`bash ${args.command}`);
      return trunc(`exit=${res.status ?? "null"}\n${out || "(no output)"}`);
    },
  },
  {
    readonly: true,
    spec: {
      name: "finish",
      description: "Signal that the task is complete. Summarize the result.",
      parameters: { type: "object", properties: { summary: str("what was accomplished") }, required: ["summary"] },
    },
    run: (args) => `done: ${args.summary ?? ""}`,
  },
];

export const WRITE_TOOLS = new Set(tools.filter((t) => !t.readonly).map((t) => t.spec.name));

export async function runTool(name: string, args: any, ctx: ToolContext, allowWrite: boolean): Promise<string> {
  const tool = tools.find((t) => t.spec.name === name);
  if (!tool) return `error: unknown tool ${name}`;
  if (!allowWrite && !tool.readonly) return `error: tool ${name} is read-only in this phase`;
  try {
    return await tool.run(args ?? {}, ctx);
  } catch (error) {
    return `error: ${(error as Error).message}`;
  }
}

export function workspaceSummary(cwd: string): string {
  const out: string[] = [];
  walk(cwd, cwd, out, 0);
  return out.slice(0, 200).join("\n");
}

export function fileStats(cwd: string, file: string): string {
  const full = resolve(cwd, file);
  if (!existsSync(full)) return `${file}: missing`;
  const s = statSync(full);
  return `${file}: ${s.size} bytes`;
}
