#!/usr/bin/env node
import { render } from "ink";
import React from "react";
import { getProvider, loadConfig } from "./config.js";
import { orchestrate } from "./orchestrator.js";
import { App } from "./ui/app.js";

const argv = process.argv.slice(2);
const command = argv[0];

async function headless(goal: string): Promise<number> {
  const config = loadConfig();
  if (!config.model) {
    console.error("localloom: no model selected. run `localloom` and type /models, or set LOCALLOOM_MODEL.");
    return 1;
  }
  const provider = getProvider(config);
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  let phase = "";
  const result = await orchestrate(
    {
      config,
      provider,
      model: config.model,
      cwd: process.cwd(),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.kind === "phase") {
          phase = event.phase;
          console.log(`\n\x1b[36m[${event.phase}]\x1b[0m`);
        } else if (event.kind === "tool") {
          console.log(`\x1b[90m  → ${event.tool} ${event.detail ?? ""}\x1b[0m`);
        } else if (event.kind === "error") {
          console.error(`\x1b[31m${event.text}\x1b[0m`);
        }
      },
    },
    goal,
  );
  void phase;
  console.log(`\n${result.summary || "(no summary)"}`);
  return 0;
}

async function main(): Promise<void> {
  if (command === "run" || (command && !command.startsWith("-") && command !== "tui" && command !== "help")) {
    const goal = command === "run" ? argv.slice(1).join(" ") : command;
    if (!goal.trim()) {
      console.error("localloom: give me a task, e.g. `localloom run \"add a health endpoint\"`");
      process.exit(1);
    }
    process.exit(await headless(goal));
  }

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(
      [
        "localloom — minimal local-first multi-agent coding TUI",
        "",
        "  localloom              open the TUI",
        "  localloom run <task>   run one task headless",
        "",
        "in the TUI: type a task and press enter · /models to switch model · esc to interrupt · ctrl+c to exit",
      ].join("\n"),
    );
    return;
  }

  const instance = render(<App />);
  await instance.waitUntilExit();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
