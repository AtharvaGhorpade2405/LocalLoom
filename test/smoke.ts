import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let turn = 0;
const server = createServer(async (req, res) => {
  if (req.url?.endsWith("/models")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "qwen2.5-coder:7b" }, { id: "llama3.1:8b" }] }));
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body || "{}");
  const last = parsed.messages?.[parsed.messages.length - 1];
  const sys = parsed.messages?.[0]?.content ?? "";
  const isPlan = sys.includes("PLANNER");
  const isBuild = sys.includes("BUILDER");
  const isReview = sys.includes("REVIEWER");

  let out;
  if (isPlan) {
    out = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                id: "c1",
                function: {
                  name: "finish",
                  arguments: JSON.stringify({
                    plan: ["create greet.ts with greet function", "export greet from index.ts"],
                    files: ["greet.ts"],
                  }),
                },
              },
            ],
          },
        },
      ],
    };
  } else if (isBuild) {
    if (turn === 0) {
      turn++;
      out = {
        choices: [
          {
            delta: {
              tool_calls: [
                { id: "c1", function: { name: "write_file", arguments: JSON.stringify({ filePath: "greet.ts", content: "export const greet = () => 'hi';\n" }) } },
              ],
            },
          },
        ],
      };
    } else if (last?.role === "tool") {
      out = {
        choices: [
          {
            delta: {
              tool_calls: [
                { id: "c2", function: { name: "finish", arguments: JSON.stringify({ summary: "Created greet.ts with greet function" }) } },
              ],
            },
          },
        ],
      };
    } else {
      out = { choices: [{ delta: { content: "all done" } }] };
    }
  } else if (isReview) {
    out = { choices: [{ delta: { content: "VERDICT: PASS" } }] };
  } else {
    out = { choices: [{ delta: { content: "ok" } }] };
  }

  res.setHeader("content-type", "text/event-stream");
  const line = `data: ${JSON.stringify(out)}\n\n`;
  res.write(line);
  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(8798, async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-"));
  const file = join(dir, "greet.ts");
  process.env.LOCALLOOM_BASE_URL = "http://127.0.0.1:8798/v1";
  process.env.LOCALLOOM_MODEL = "qwen2.5-coder:7b";
  process.env.LOCALLOOM_CONFIG = join(dir, "config.json");
  process.chdir(dir);

  const { orchestrate } = await import("../src/orchestrator.js");
  const { loadConfig, getProvider } = await import("../src/config.js");
  const config = loadConfig();
  const events = [];
  const result = await orchestrate(
    {
      config,
      provider: getProvider(config),
      model: config.model,
      cwd: dir,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e.kind + ":" + (e.tool ?? e.text ?? "")),
    },
    "add a greet function",
  );

  const wrote = existsSync(file) ? readFileSync(file, "utf8") : "";
  console.log("phases:", [...new Set(events.filter((e) => e.startsWith("phase:")))].join(" "));
  console.log("events:", JSON.stringify(events.filter((e) => e.startsWith("tool:") || e.startsWith("error:")), null, 1));
  console.log("summary:", result.summary);
  server.close();
  if (!wrote.includes("greet") || !result.summary) {
    console.error("SMOKE FAIL");
    process.exit(1);
  }
  console.log("SMOKE OK");
  process.exit(0);
});