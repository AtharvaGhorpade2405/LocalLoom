/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { ModelInfo } from "@opencode/client"
import { DialogModel } from "../src/component/dialog-model"
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

test("renders local models with identifier, display name, and active badge", async () => {
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
  // Verify cloud providers are completely absent
  expect(frame).not.toContain("openai")
  expect(frame).not.toContain("anthropic")
})

test("allows selecting a model and persists selection to current model", async () => {
  const qwen = ollamaModel("qwen2.5-coder:7b", "Qwen 2.5 Coder 7B")
  const llama = ollamaModel("llama3.2:3b", "Llama 3.2 3B")

  await using setup = await renderLocal({
    models: [qwen, llama],
    preferences: { recent: [{ providerID: "ollama", modelID: "qwen2.5-coder:7b" }] },
  })

  setup.dialog.replace(() => <DialogModel />)
  await setup.waitForFrame((frame) => frame.includes("Qwen 2.5 Coder 7B"))

  // Navigate down to llama3.2:3b and press Enter
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()

  await setup.waitFor(() => setup.local.model.current()?.modelID === "llama3.2:3b")
  expect(setup.local.model.current()).toEqual({
    providerID: "ollama",
    modelID: "llama3.2:3b",
  })
})

test("applies model selection to active session via switchModel", async () => {
  const qwen = ollamaModel("qwen2.5-coder:7b", "Qwen 2.5 Coder 7B")
  const llama = ollamaModel("llama3.2:3b", "Llama 3.2 3B")
  let switched: unknown

  await using setup = await renderLocal({
    models: [qwen, llama],
    fetch: async (url, request) => {
      if (url.pathname === "/api/session/ses_test/model" && request.method === "POST") {
        switched = await request.json()
        return new Response(null, { status: 204 })
      }
      return undefined
    },
  })

  setup.route.navigate({ type: "session", sessionID: "ses_test" })

  setup.dialog.replace(() => <DialogModel />)
  await setup.waitForFrame((frame) => frame.includes("Qwen 2.5 Coder 7B"))

  // Select llama3.2:3b
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()

  await setup.waitFor(() => switched !== undefined)
  expect(switched).toEqual({
    model: { providerID: "ollama", id: "llama3.2:3b" },
  })
})

test("cancellation via escape preserves existing model selection and clears dialog", async () => {
  const qwen = ollamaModel("qwen2.5-coder:7b", "Qwen 2.5 Coder 7B")
  const llama = ollamaModel("llama3.2:3b", "Llama 3.2 3B")

  await using setup = await renderLocal({
    models: [qwen, llama],
    preferences: { recent: [{ providerID: "ollama", modelID: "qwen2.5-coder:7b" }] },
  })

  setup.dialog.replace(() => <DialogModel />)
  await setup.waitForFrame((frame) => frame.includes("Qwen 2.5 Coder 7B"))

  // Move selection cursor
  setup.mockInput.pressArrow("down")

  // Cancel via Escape
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Select model"))

  // Selection must not have changed
  expect(setup.local.model.current()?.modelID).toBe("qwen2.5-coder:7b")
})

test("displays actionable error view when no local models are installed or runtime is disconnected", async () => {
  await using setup = await renderLocal({ models: [] })

  setup.dialog.replace(() => <DialogModel />)

  await setup.waitForFrame((frame) => frame.includes("No local models found"))
  const frame = setup.captureCharFrame()
  expect(frame).toContain("No local models found")
  expect(frame).toContain("http://127.0.0.1:")
  expect(frame).toContain("11434")
  expect(frame).toContain("Install models with: ollama pull qwen2.5-coder:7b")
  expect(frame).toContain("refresh models")
})
