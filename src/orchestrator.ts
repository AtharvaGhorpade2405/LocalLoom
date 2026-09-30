import { basename, relative, resolve } from "node:path";
import type { ChatMessage, ChatResult, ToolSpec } from "./llm.js";
import { chat } from "./llm.js";
import type { Config, Provider } from "./config.js";
import { runTool, tools } from "./tools.js";

export type Phase = "plan" | "build" | "review" | "fix" | "direct";

export interface AgentEvent {
  kind: "phase" | "text" | "tool" | "tool_result" | "result" | "error" | "done";
  phase: Phase;
  text?: string;
  tool?: string;
  detail?: string;
}

const SHARED = `You are localloom, a local-first coding agent working inside a user's project.
Always use paths relative to the project root — never absolute paths.
Read a file before editing it. Keep changes minimal and match existing code style.
Do NOT narrate, explain your plan, or describe what you will do.
Respond ONLY with tool calls. When the task is complete, call the finish tool.`;

const PLANNER = `You are the PLANNER agent. You do not modify files.
Break the user's goal into a short ordered plan. Output at most 6 numbered steps, each one concrete.
Mention the exact files you expect to create or change. Be brief.
When done, call the finish tool with a JSON object: {"plan": ["step 1", "step 2", ...], "files": ["file1", "file2", ...]}`;

const BUILDER = `You are the BUILDER agent. Execute the plan step by step using your tools.
Work through each step: read files, write code, run commands as needed.
Do NOT explain what you are doing — just use tools. When done, call the finish tool with a brief summary.`;

const REVIEWER = `You are the REVIEWER agent. You inspect the workspace after the builder worked.
Read the changed files, then output a verdict on the first line in the form VERDICT: PASS or VERDICT: FAIL.
After the verdict, list at most 5 concrete problems or improvements, one per line, most severe first.
If the work is correct and complete, PASS with no further notes.`;

export interface AgentOptions {
  config: Config;
  provider: Provider;
  model: string;
  cwd: string;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}

export interface RunResult {
  summary: string;
  transcript: string;
}

export async function runAgent(opts: AgentOptions, goal: string, phase: Phase, history: ChatMessage[] = []): Promise<RunResult> {
  const { config, provider, model, cwd, signal, onEvent } = opts;
  const system = [SHARED, phase === "plan" ? PLANNER : phase === "build" ? BUILDER : phase === "review" ? REVIEWER : ""].filter(Boolean).join("\n\n");
  const allowWrite = phase === "build" || phase === "fix" || phase === "direct";
  const specs: ToolSpec[] = tools
    .filter((t) => (phase === "plan" || phase === "review" ? t.readonly || t.spec.name === "finish" : true))
    .map((t) => t.spec);

  // Build a compact tool reference for the system prompt so models that don't support
  // native function calling still know the exact tool names and argument shapes.
  const toolRef = specs.map((t) => {
    const params = (t.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {};
    const args = Object.entries(params).map(([k, v]) => `${k}: ${v.description ?? "string"}`).join(", ");
    return `  ${t.name}(${args}) — ${t.description}`;
  }).join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: `${system}\n\nProject root: ${cwd}\nProject name: ${basename(cwd) || "workspace"}\n\nAvailable tools (use these EXACT names):\n${toolRef}` },
    ...history,
    { role: "user", content: goal },
  ];

  const transcript: string[] = [];
  let summary = "";

  for (let step = 0; step < config.maxSteps; step++) {
    if (signal.aborted) break;
    onEvent({ kind: "phase", phase, text: step === 0 ? phase : `${phase} · step ${step + 1}` });

    let result: ChatResult;
    try {
      result = await chat({
        provider,
        model,
        messages,
        tools: specs,
        temperature: phase === "plan" ? 0.1 : phase === "review" ? 0.1 : config.temperature,
        signal,
        onDelta: (text) => onEvent({ kind: "text", phase, text }),
      });
    } catch (error) {
      if (signal.aborted) break;
      const message = (error as Error).message;
      onEvent({ kind: "error", phase, text: message });
      throw error;
    }

    if (result.text) transcript.push(`[${phase}] ${result.text}`);
    messages.push({ role: "assistant", content: result.text, tool_calls: result.toolCalls.length ? result.toolCalls : undefined });

    if (result.toolCalls.length === 0) {
      summary = result.text;
      break;
    }

    let finished = false;
    for (const call of result.toolCalls) {
      if (signal.aborted || finished) break;
      const preview = JSON.stringify(call.arguments).slice(0, 120);
      onEvent({ kind: "tool", phase, tool: call.name, detail: preview });
      const isFinish = call.name === "finish";
      const finishArgs = call.arguments as Record<string, unknown>;
      const finishSummary = isFinish
        ? (finishArgs.plan
            ? JSON.stringify({ plan: finishArgs.plan, files: finishArgs.files ?? [] })
            : String(finishArgs.summary ?? result.text))
        : "";
      const output = isFinish
        ? finishSummary
        : await runTool(call.name, call.arguments, { cwd, emit: (line) => onEvent({ kind: "tool_result", phase, text: line }) }, allowWrite);
      if (isFinish) {
        summary = finishSummary;
        finished = true;
      }
      const shown = output.length > 600 ? `${output.slice(0, 600)}\n…(${output.length - 600} chars)` : output;
      onEvent({ kind: "tool_result", phase, text: shown, tool: call.name });
      messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: shown });
    }

    if (finished) break;
    if (!result.toolCalls.length) break;
  }

  onEvent({ kind: "result", phase, text: summary });
  return { summary, transcript: transcript.join("\n\n") };
}

function extractPlan(summary: string): { plan: string[]; files: string[] } {
  try {
    const parsed = JSON.parse(summary);
    if (parsed.plan && Array.isArray(parsed.plan)) return { plan: parsed.plan, files: parsed.files ?? [] };
  } catch { }
  return { plan: summary.split("\n").filter(Boolean), files: [] };
}

export async function orchestrate(opts: AgentOptions, goal: string): Promise<RunResult> {
  const { config, signal, onEvent } = opts;
  const shared: ChatMessage[] = [];
  let final: RunResult = { summary: "", transcript: "" };

  if (signal.aborted) return final;

  if (config.orchestrator.enabled) {
    const plan = await runAgent(opts, goal, "plan", shared);
    if (signal.aborted) return final;
    const { plan: steps, files } = extractPlan(plan.summary);
    const planText = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
    shared.push({ role: "user", content: `Plan:\n${planText}\n\nFiles to touch:\n${files.join("\n") || "(none)"}` });

    const build = await runAgent(opts, goal, "build", [...shared]);
    if (signal.aborted) return final;
    shared.push({ role: "user", content: `Builder report:\n${build.summary || build.transcript.slice(-2000)}` });
    final = build;

    if (config.orchestrator.review) {
      for (let round = 0; round < config.orchestrator.maxRounds; round++) {
        const review = await runAgent(opts, goal, "review", [...shared]);
        if (signal.aborted) return final;
        if (/VERDICT:\s*PASS/i.test(review.summary)) break;
        const fix = await runAgent(opts, `The reviewer found issues. Fix them with your tools:\n\n${review.summary}`, "fix", [...shared]);
        shared.push({ role: "user", content: `Fix round ${round + 1}:\n${fix.summary}` });
        final = fix;
      }
    }
  } else {
    final = await runAgent(opts, goal, "direct", shared);
  }

  onEvent({ kind: "done", phase: "direct", text: final.summary });
  return final;
}

export function shortGoal(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 400) || `work in ${relative(process.cwd(), resolve(".")) || "."}`;
}
