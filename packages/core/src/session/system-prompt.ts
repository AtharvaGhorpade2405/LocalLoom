export * as SessionSystemPrompt from "./system-prompt.js"

import PROMPT from "./runner/prompt/system.txt"

export function make(tools: string[]) {
  return render(PROMPT, tools)
}

export function render(prompt: string, tools: string[]) {
  const instructions: string[] = []
  if (tools.includes("shell")) {
    instructions.push(
      "- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.",
      "- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.",
    )
  }
  if (tools.includes("write")) {
    instructions.push(
      "- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.",
    )
  }
  if (tools.includes("edit")) {
    instructions.push(
      "- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.",
    )
  }
  if (tools.includes("subagent")) {
    instructions.push(
      "- Multi-Agent Orchestration: You own the task lifecycle and coordinate specialist subagents via the subagent tool:",
      "  * planner: Analyzes requirements, inspects codebase, and designs bounded sequential execution steps. Read-only.",
      "  * coder: Implements bounded code changes using edit/write/patch tools and executes tests. Cannot spawn subagents.",
      "  * reviewer: Evaluates changes, runs tests and linters via shell, and reports defects. Read-only.",
      "  * Workflow: For non-trivial coding tasks, follow sequential lifecycle: PLAN (planner) -> CODE (coder) -> REVIEW (reviewer). If reviewer reports defects, direct coder to fix them (up to 2 retries).",
      "  * Context: Provide bounded task prompts with specific file targets and requirements without copying full conversation history.",
      "  * Final Summary: Always conclude with Changes Made, Checks Performed, and Unresolved Issues.",
    )
  }
  return prompt.replace("${OPENCODE_TOOL_GUIDANCE}", instructions.join("\n"))
}
