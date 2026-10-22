# LocalLoom

> **High-performance, local-first AI coding agent powered by Ollama.**

LocalLoom is a lightweight, privacy-focused coding assistant engineered for 100% offline local inference. It combines an OpenTUI terminal interface, durable SQLite session persistence, specialized multi-agent orchestration, and workspace coding tools—with zero remote cloud fallbacks.

---

## Key Features

- **100% Local Inference**: Direct streaming via local Ollama (`http://127.0.0.1:11434`), defaulting to `qwen2.5-coder:7b`. Cloud inference and remote fallback are strictly forbidden.
- **Interactive Model Selection (`/models`)**: Keyboard-navigable dialog to inspect local model inventory, view parameter counts, switch models on the fly, and persist preferences.
- **Multi-Agent Orchestration**:
  - **Planner**: Deconstructs user requests into bounded, verifiable steps.
  - **Coder**: Executes file edits and runs terminal commands within project boundaries.
  - **Reviewer**: Inspects diffs, runs test suites, and validates correctness.
  - Includes loop prevention, concurrency limits, and conflicting file-edit locks.
- **Durable Conversation History**: SQLite & Drizzle ORM persistence preserving message order, model selection, tool invocations, and session continuity across application restarts.
- **Workspace Tools**: File reading, exact-string editing, file diffs, glob/grep search, AST codemode tools, and controlled shell execution with safety checks.
- **Polished Terminal Interface**: Built with OpenTUI and SolidJS, featuring real-time token streaming, active model indicators, tool status cards, and notification sounds.

---

## Quickstart

### Prerequisites

1. **Bun runtime** (version 1.2+):
   ```bash
   curl -fsSL https://bun.sh/install | bash  # macOS/Linux
   powershell -c "irm bun.sh/install.ps1 | iex"  # Windows
   ```
2. **Ollama** running locally with a compatible coding model:
   ```bash
   ollama serve
   ollama pull qwen2.5-coder:7b
   ```

### Installation

```bash
git clone https://github.com/AtharvaGhorpade2405/LocalLoom.git
cd LocalLoom
bun install
```

### Launch the Application

```bash
# Run the live TUI interface
bun run dev:live

# Or launch directly from packages/cli
bun run dev
```

---

## Architecture

LocalLoom is structured as a lean, focused workspace:

```text
localloom/
├── packages/
│   ├── cli/            # CLI entrypoint and binary dispatcher
│   ├── tui/            # OpenTUI terminal interface with model dialog and chat timeline
│   ├── server/         # Background HTTP daemon hosting local session RPC endpoints
│   ├── core/           # Session coordinator, specialist agents, tool registry, SQLite store
│   ├── schema/         # Effect Schema definitions for models, config, and tools
│   ├── protocol/       # RPC protocol definitions shared across Client, Server, and TUI
│   ├── client/         # Typed RPC client for internal daemon communication
│   ├── codemode/       # AST-based code transformation tools
│   ├── theme/          # Semantic TUI theme tokens and styling
│   ├── util/           # Low-level Effect platform helpers and filesystem utilities
│   ├── plugin/         # Plugin interfaces and hook contracts
│   └── ui/             # Notification audio assets
├── package.json        # Lean workspace configuration (~550 MB node_modules)
└── bunfig.toml
```

---

## Verification & Testing

LocalLoom includes a comprehensive automated test suite covering all local-first workflows:

```bash
# Test local model selection and zero-cloud fallback policies
cd packages/core
bun test test/local-model.test.ts

# Test specialist agent orchestration and file locks
bun test test/orchestration.test.ts

# Test conversation persistence and restart recovery
bun test test/conversation-history.test.ts

# Run end-to-end integration workflows
bun test test/e2e-verification.test.ts

# Test TUI dialogs and interface polish
cd ../tui
bun test test/dialog-model.test.tsx
bun test test/ui-polish.test.tsx
```

---

## License

MIT
