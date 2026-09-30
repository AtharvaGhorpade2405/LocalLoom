# localloom

Minimal local-first multi-agent coding TUI. Type `localloom` to enter the UI, press `/models` to pick a local LLM, then describe a task.

## Quickstart

```bash
# install
git clone https://github.com/AtharvaGhorpade2405/LocalLoom
cd localloom
npm install
npm link       # puts `localloom` on PATH

# run a local model server (pick one)
# ollama:    ollama serve
# LM Studio: start server on port 1234
# llama.cpp: llama-server -m model.gguf --port 8080
# vLLM:      vllm serve <model> --port 8000

# enter the TUI
localloom
# in TUI: press /models to select model, then type your task and press Enter
```

Or run headless:
```bash
localloom run "add a health endpoint to the express app"
```

## Requirements

- Node.js 18+
- A local LLM server (Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible endpoint)

## Configuration

Config is loaded from (highest priority wins):
1. `LOCALLOOM_BASE_URL` + `LOCALLOOM_MODEL` env vars
2. `localloom.json` in current directory
3. `~/.config/localloom/config.json` (or `%APPDATA%\localloom\config.json` on Windows)

Example `~/.config/localloom/config.json`:
```json
{
  "model": "qwen2.5-coder:7b",
  "providerId": "ollama",
  "providers": [
    { "id": "ollama", "kind": "ollama", "baseUrl": "http://127.0.0.1:11434" },
    { "id": "lmstudio", "kind": "openai", "baseUrl": "http://127.0.0.1:1234/v1", "apiKey": "lm-studio" }
  ],
  "orchestrator": { "enabled": true, "review": true, "maxRounds": 1 },
  "maxSteps": 24,
  "temperature": 0.2
}
```

## TUI Controls

| Key | Action |
|-----|--------|
| Enter | Send task |
| `/models` | Open model picker (arrow keys, Enter to select, Esc to cancel, type to filter) |
| Esc | Interrupt running agent |
| Ctrl+C | Exit (twice if running) |

## Architecture

```
localloom/
  src/
    index.tsx       # CLI entry: TUI or `run <task>`
    config.ts       # Config + provider registry + model persistence
    llm.ts          # OpenAI-compatible + Ollama chat streaming, model discovery
    tools.ts        # read, write, edit, bash, list, grep, finish
    orchestrator.ts # Multi-agent pipeline: plan → build → review → fix loop
    ui/
      app.tsx       # Ink TUI: Static history + live streaming + /models dialog
      markdown.tsx  # Lightweight markdown renderer (code fences, headings, inline)
      models.tsx    # Model picker dialog
```

### Multi-agent pipeline

1. **plan** (read-only): breaks goal into 3-6 concrete steps with file names
2. **build**: executes plan using tools (read/write/edit/bash/grep/list)
3. **review** (read-only): inspects changes, emits `VERDICT: PASS` or `VERDICT: FAIL` + issues
4. **fix** (loops up to `maxRounds`): applies reviewer's fixes

Disable with `"orchestrator": { "enabled": false }` in config for direct single-agent mode.

## Tools

| Tool | Read-only? | Description |
|------|------------|-------------|
| `read` | yes | Read file with line numbers, optional offset/limit |
| `list` | yes | Recursive directory listing (skips node_modules/.git/dist) |
| `grep` | yes | Regex search across source files |
| `write` | no | Create/overwrite file |
| `edit` | no | Exact-string replace in existing file |
| `bash` | no | Shell command in workspace root |
| `finish` | — | Signal completion with summary |

## Development

```bash
npm run build      # compile to dist/
npm run typecheck  # strict TS check
npm run tui        # run from source (tsx)
```

## License

MIT