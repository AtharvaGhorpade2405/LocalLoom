/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import type { AgentInfo, ModelInfo } from "@opencode/client"
import { DialogModel } from "../src/component/dialog-model"
import { DialogAgent } from "../src/component/dialog-agent"
import { InlineToolRow } from "../src/routes/session/message-parts"
import { PromptMetadataRow } from "../src/component/prompt/metadata"
import { renderLocal } from "./fixture/local"

function ollamaModel(id: string, name = id): ModelInfo {
  return {
    id,
    modelID: id,
    providerID: "ollama",
    name,
    status: "active",
    enabled: true,
    capabilities: { input: ["text"], output: ["text"], tools: true },
    cost: [],
    limit: { context: 131072, output: 16384 },
    time: { released: 1000 },
    variants: [],
  }
}

function makeAgent(id: string, name: string, description: string): AgentInfo {
  return {
    id,
    name,
    description,
    mode: "primary",
    hidden: false,
    permissions: [],
    request: { settings: {}, headers: {}, body: {} },
  }
}

test("Model selection UI renders active indicators and Ollama model IDs clearly", async () => {
  const qwen = ollamaModel("qwen2.5-coder:7b", "Qwen 2.5 Coder 7B")
  const llama = ollamaModel("llama3.2:3b", "Llama 3.2 3B")

  await using setup = await renderLocal({
    models: [qwen, llama],
    preferences: { recent: [{ providerID: "ollama", modelID: "qwen2.5-coder:7b" }] },
  })

  setup.dialog.replace(() => <DialogModel />)

  await setup.waitForFrame((frame) => frame.includes("Qwen 2.5 Coder 7B"))
  const frame = setup.captureCharFrame()

  expect(frame).toContain("Qwen 2.5 Coder 7B")
  expect(frame).toContain("ollama/qwen2.5-coder:7b")
  expect(frame).toContain("Active")
  expect(frame).toContain("Llama 3.2 3B")
  expect(frame).toContain("ollama/llama3.2:3b")
  expect(frame).toContain("refresh models")
  // Cloud providers are strictly excluded
  expect(frame).not.toContain("openai")
  expect(frame).not.toContain("anthropic")
})

test("Agent selection UI displays formatted names and role descriptions", async () => {
  const buildAgent = makeAgent("build", "Build", "Primary coordinator agent. Plans and delegates.")
  const generalAgent = makeAgent("general", "General", "General conversation and queries.")

  await using setup = await renderLocal({
    agents: [buildAgent, generalAgent],
  })

  setup.dialog.replace(() => <DialogAgent />)

  await setup.waitForFrame((frame) => frame.includes("Build"))
  const frame = setup.captureCharFrame()

  expect(frame).toContain("Select agent")
  expect(frame).toContain("Build")
  expect(frame).toContain("Primary coordinator agent")
  expect(frame).toContain("General")
  expect(frame).toContain("General conversation and queries")
})

test("Prompt metadata row renders active local model, provider, and agent role", async () => {
  await using setup = await renderLocal({})

  setup.dialog.replace(() => (
    <box flexDirection="column" gap={1}>
      <PromptMetadataRow
        mode="normal"
        agent="Build"
        auto={false}
        model="qwen2.5-coder:7b"
        provider="ollama"
        variant="default"
        muted={false}
        highlight={RGBA.fromValues(1, 1, 1, 1)}
        agentAlpha={1}
        modelAlpha={1}
        variantAlpha={1}
      />
    </box>
  ))

  await setup.renderOnce()
  const frame = setup.captureCharFrame()

  expect(frame).toContain("Build")
  expect(frame).toContain("qwen2.5-coder:7b")
  expect(frame).toContain("ollama")
})

test("Tool activity rows render pending spinners, completed icons, and actionable errors", async () => {
  await using setup = await renderLocal({})

  setup.dialog.replace(() => (
    <box flexDirection="column" gap={1}>
      <InlineToolRow
        icon="✓"
        complete={true}
        pending="Reading file"
      >
        read src/index.ts
      </InlineToolRow>
      <InlineToolRow
        icon="✗"
        complete={false}
        failed={true}
        failure="Command failed with exit code 1"
        error="Permission denied when writing to protected directory"
        errorExpanded={true}
        pending="Running build"
      >
        make test
      </InlineToolRow>
    </box>
  ))

  await setup.renderOnce()
  const frame = setup.captureCharFrame()

  expect(frame).toContain("read src/index.ts")
  expect(frame).toContain("Command failed with exit code 1")
  expect(frame).toContain("Permission denied when writing to protected directory")
})

test("Offline / disconnected Ollama displays clear actionable troubleshooting guidance", async () => {
  await using setup = await renderLocal({
    models: [],
  })

  setup.dialog.replace(() => <DialogModel />)

  await setup.waitForFrame((frame) => frame.includes("No local models found"))
  const frame = setup.captureCharFrame()

  expect(frame).toContain("No local models found")
  expect(frame).toContain("Please ensure Ollama is running at http://127.0.0.1:")
  expect(frame).toContain("Install models with: ollama pull qwen2.5-coder:7b")
  expect(frame).toContain("refresh models")
})
