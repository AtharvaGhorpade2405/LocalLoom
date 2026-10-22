import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { ProviderPlugins } from "@opencode/core/plugin/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Money } from "@opencode/schema/money"
import { location } from "./fixture/location"
import { globalProjectNode } from "./lib/project"
import { promptLocationNode } from "./fixture/prompt-location"
import { testEffect } from "./lib/effect"

const ref = location({ directory: AbsolutePath.make("/test") })

const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    Bus.node,
    SessionProjector.node,
    SessionStore.node,
    Session.node,
    Provider.node,
    Model.node,
    ModelResolver.node,
    SessionRunnerModel.node,
  ]),
  [
    Bus.node.replace(Bus.configured({ persist: true })),
    Project.node.replace(globalProjectNode),
    LocationServiceMap.node.replace(promptLocationNode),
    Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(ref))),
    SessionExecution.node.replace(SessionExecution.noopLayer),
  ],
)

const it = testEffect(layer)

describe("Local Model Policy", () => {
  it.effect("registers only the Ollama provider plugin and excludes all cloud providers", () =>
    Effect.sync(() => {
      expect(ProviderPlugins.length).toBe(1)
      expect(ProviderPlugins[0].id).toBe("opencode.provider.ollama")
      const pluginIds = ProviderPlugins.map((p) => p.id)
      expect(pluginIds).not.toContain("opencode.provider.openai")
      expect(pluginIds).not.toContain("opencode.provider.anthropic")
      expect(pluginIds).not.toContain("opencode.provider.google")
      expect(pluginIds).not.toContain("opencode.provider.amazon-bedrock")
    }),
  )

  it.effect("prioritizes qwen2.5-coder:7b as the preferred local model", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      const models = yield* Model.Service
      const providerID = Provider.ID.make("ollama")

      yield* providers.transform((editor) => {
        editor.update(providerID, () => {})
        editor.models.update(providerID, Model.ID.make("llama3.2:3b"), (model) => {
          model.time.released = 1000
          model.capabilities = { ...model.capabilities, input: ["text"], output: ["text"] }
        })
        editor.models.update(providerID, Model.ID.make("qwen2.5-coder:7b"), (model) => {
          model.time.released = 500
          model.capabilities = { ...model.capabilities, input: ["text"], output: ["text"] }
        })
        editor.models.update(providerID, Model.ID.make("mistral:7b"), (model) => {
          model.time.released = 800
          model.capabilities = { ...model.capabilities, input: ["text"], output: ["text"] }
        })
      })

      const available = yield* models.available()
      expect(available.length).toBe(3)
      expect(available[0].id).toBe(Model.ID.make("qwen2.5-coder:7b"))

      const defaultModel = yield* models.default()
      expect(defaultModel?.id).toBe(Model.ID.make("qwen2.5-coder:7b"))
    }),
  )

  it.effect("rejects cloud provider resolution with an explicit actionable message", () =>
    Effect.gen(function* () {
      const runner = yield* SessionRunnerModel.Service
      const models = yield* Model.Service

      const fakeSession = Session.Info.make({
        id: Session.ID.make("ses_test123"),
        projectID: Project.ID.global,
        title: "Test session",
        model: {
          providerID: Provider.ID.make("openai"),
          id: Model.ID.make("gpt-4o"),
        },
        cost: Money.USD.zero,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2) },
        location: ref,
      })

      const result = yield* runner.resolve(fakeSession, () => models.available()).pipe(Effect.flip)
      expect(result._tag).toBe("SessionRunnerModel.ModelUnavailableError")
      expect(result.message).toContain("Cloud providers are disabled in this local-only environment")
      expect(result.message).toContain("Please select an installed Ollama model using /models")
    }),
  )

  it.effect("fails with ModelNotSelectedError when no Ollama models are available", () =>
    Effect.gen(function* () {
      const runner = yield* SessionRunnerModel.Service
      const models = yield* Model.Service

      const emptySession = Session.Info.make({
        id: Session.ID.make("ses_empty"),
        projectID: Project.ID.global,
        title: "Empty session",
        cost: Money.USD.zero,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2) },
        location: ref,
      })

      const result = yield* runner.resolve(emptySession, () => models.available()).pipe(Effect.flip)
      expect(result._tag).toBe("SessionRunnerModel.ModelNotSelectedError")
      expect(result.message).toContain("No local model is available")
      expect(result.message).toContain("Please ensure Ollama is running at http://127.0.0.1:11434")
      expect(result.message).toContain("ollama pull qwen2.5-coder:7b")
    }),
  )

  it.effect("persists local model switch on Session and preserves it across retrieval", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const providers = yield* Provider.Service
      const providerID = Provider.ID.make("ollama")

      // Register local Ollama model in provider service
      yield* providers.transform((editor) => {
        editor.update(providerID, (provider) => {
          provider.name = "Ollama"
          provider.activation = "enabled"
          provider.package = "@opencode/ai/providers/openai-compatible"
          provider.settings = { baseURL: "http://127.0.0.1:11434/v1" }
        })
        editor.models.update(providerID, Model.ID.make("qwen2.5-coder:7b"), (model) => {
          model.time.released = 500
          model.capabilities = { ...model.capabilities, input: ["text"], output: ["text"] }
        })
      })

      // Create session
      const created = yield* session.create({ location: ref })
      expect(created.model).toBeUndefined()

      // Switch to local model
      const ollamaModel = Model.Ref.make({
        providerID: Provider.ID.make("ollama"),
        id: Model.ID.make("qwen2.5-coder:7b"),
      })
      yield* session.switchModel({ sessionID: created.id, model: ollamaModel })

      // Verify the session record has the model saved
      const loaded = yield* session.get(created.id)
      expect(loaded.model).toMatchObject(ollamaModel)

      // Verify SessionRunnerModel resolves this saved model
      const runner = yield* SessionRunnerModel.Service
      const models = yield* Model.Service
      const resolved = yield* runner.resolve(loaded, () => models.available())
      expect(resolved.model.id as string).toBe("qwen2.5-coder:7b")
      expect(resolved.ref.id).toBe(Model.ID.make("qwen2.5-coder:7b"))
    }),
  )

  it.effect("rejects switching to cloud provider models during execution resolution", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const runner = yield* SessionRunnerModel.Service
      const models = yield* Model.Service

      const created = yield* session.create({ location: ref })
      const cloudModel = Model.Ref.make({
        providerID: Provider.ID.make("anthropic"),
        id: Model.ID.make("claude-3-5-sonnet"),
      })

      yield* session.switchModel({ sessionID: created.id, model: cloudModel })
      const loaded = yield* session.get(created.id)
      expect(loaded.model).toMatchObject(cloudModel)

      // When execution attempts to resolve this cloud model, it fails with local-only error
      const result = yield* runner.resolve(loaded, () => models.available()).pipe(Effect.flip)
      expect(result._tag).toBe("SessionRunnerModel.ModelUnavailableError")
      expect(result.message).toContain("Cloud providers are disabled in this local-only environment")
    }),
  )
})
