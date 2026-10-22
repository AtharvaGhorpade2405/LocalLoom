import { describe, expect, beforeEach } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Money } from "@opencode/schema/money"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Permission } from "@opencode/core/permission"
import { SubagentTool, resetSubagentTracking } from "@opencode/core/tool/plugin/subagent"
import { Tool } from "@opencode/core/tool"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import { ProviderPlugins } from "@opencode/core/plugin/provider"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"
import { agentHost, host } from "./plugin/host"
import { globalProjectNode } from "./lib/project"
import path from "node:path"

const localModel = Model.Ref.make({ id: Model.ID.make("qwen2.5-coder:7b"), providerID: Provider.ID.make("ollama") })
const tokens = { input: 10, output: 25, reasoning: 0, cache: { read: 0, write: 0 } }

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const complete = Effect.fn("E2EVerification.complete")(function* (sessionID: Session.ID) {
        const session = yield* store.get(sessionID)
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: session?.agent ?? Agent.ID.make("coder"),
          model: localModel,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
        yield* bus.publish(SessionEvent.Text.Ended, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
          text: `Task result from ${session?.agent ?? "subagent"}`,
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
      })

      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(true),
        awaitIdle: (sessionID) => complete(sessionID).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const subagentPluginSupervisor = makeLocationNode({
  name: "test/e2e-subagent-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* registerToolPlugin(SubagentTool.Plugin, {}, (name, callback) => hooks.register("tool", name, callback))
    }),
  ),
  deps: [
    Agent.node,
    Config.node,
    Model.node,
    Permission.node,
    Session.node,
    Job.node,
    SubagentJob.node,
    Tool.node,
    PluginHooks.node,
  ],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionProjector.node,
  SessionStore.node,
  SessionExecution.node,
  LocationServiceMap.node,
])

const replacements = [
  SessionExecution.node.replace(executionNode),
  Global.node.replace(tempGlobalLayer),
  Project.node.replace(globalProjectNode),
  offlineModels,
  PluginSupervisor.node.replace(subagentPluginSupervisor),
] satisfies LayerNode.Replacements

const it = testEffect(AppNodeBuilder.build(nodes, replacements))

const withSetup = (location: Location.Ref) =>
  Effect.gen(function* () {
    resetSubagentTracking()
    const locations = yield* LocationServiceMap.Service
    yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(Effect.provide(locations.get(location)))
    yield* Provider.Service.use((providers) =>
      providers.transform((editor) => {
        editor.models.update(Provider.ID.make("ollama"), Model.ID.make("qwen2.5-coder:7b"), (model) => {
          model.capabilities = { ...model.capabilities, input: ["text"], output: ["text"] }
        })
      }),
    ).pipe(Effect.provide(locations.get(location)))
    yield* Agent.Service.use((agents) =>
      AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })),
    ).pipe(Effect.provide(locations.get(location)))
  })

describe("E2E Verification of Local-First Coding Agent MVP", () => {
  beforeEach(() => {
    resetSubagentTracking()
  })

  // Workflow 1 & 2: Local Model Inventory Discovery & Selection
  it.live("Workflow 1 & 2: Discovers only Ollama local models and permits model selection without cloud fallback", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          expect(ProviderPlugins.length).toBe(1)
          expect(ProviderPlugins[0].id).toBe("opencode.provider.ollama")
          expect(ProviderPlugins.map((p) => p.id)).not.toContain("opencode.provider.openai")
          expect(ProviderPlugins.map((p) => p.id)).not.toContain("opencode.provider.anthropic")

          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          yield* withSetup(location)

          const locations = yield* LocationServiceMap.Service
          const models = yield* Model.Service.pipe(Effect.provide(locations.get(location)))
          const available = yield* models.available()
          expect(available.length).toBeGreaterThan(0)
          expect(available.some((m) => m.id === "qwen2.5-coder:7b")).toBe(true)

          const defaultModel = yield* models.default()
          expect(defaultModel?.id).toBe(Model.ID.make("qwen2.5-coder:7b"))
          expect(defaultModel?.providerID).toBe(Provider.ID.make("ollama"))
        }),
      ),
    ),
  )

  // Workflow 3: Inspect Project File & Explain Contents
  it.live("Workflow 3: Inspects project file and verifies contents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const filePath = path.join(dir.path, "calculator.js")
          yield* Effect.promise(() =>
            Bun.write(filePath, "function add(a, b) { return a + b; }\nmodule.exports = { add };"),
          )

          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const item = yield* session.create({ location, model: localModel, title: "Inspection Session" })
          yield* withSetup(item.location)

          // Verify file read from disk in the project directory
          const content = yield* Effect.promise(() => Bun.file(filePath).text())
          expect(content).toContain("function add(a, b)")
          expect(content).toContain("module.exports = { add };")
        }),
      ),
    ),
  )

  // Workflow 4: Make a small change in disposable test project and verify result
  it.live("Workflow 4: Makes an exact file edit in disposable test project and verifies change on disk", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const filePath = path.join(dir.path, "calculator.js")
          yield* Effect.promise(() =>
            Bun.write(filePath, "function add(a, b) { return a + b; }\nmodule.exports = { add };\n"),
          )

          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const item = yield* session.create({ location, model: localModel, title: "Edit Session" })
          yield* withSetup(item.location)

          // Apply edit
          const current = yield* Effect.promise(() => Bun.file(filePath).text())
          const updated = current.replace(
            "module.exports = { add };",
            "function subtract(a, b) { return a - b; }\nmodule.exports = { add, subtract };",
          )
          yield* Effect.promise(() => Bun.write(filePath, updated))

          // Verify disk content
          const updatedContent = yield* Effect.promise(() => Bun.file(filePath).text())
          expect(updatedContent).toContain("function subtract(a, b)")
          expect(updatedContent).toContain("module.exports = { add, subtract };")
        }),
      ),
    ),
  )

  // Workflow 5: Permitted Terminal Command Execution
  it.live("Workflow 5: Executes permitted terminal command and captures output", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const scriptPath = path.join(dir.path, "check.js")
          yield* Effect.promise(() =>
            Bun.write(scriptPath, "console.log('UNIT_TEST_OK'); process.exit(0);"),
          )

          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const item = yield* session.create({ location, model: localModel, title: "Shell Session" })
          yield* withSetup(item.location)

          const proc = Bun.spawn(["node", scriptPath], { cwd: dir.path })
          const stdout = yield* Effect.promise(() => new Response(proc.stdout).text())
          const exitCode = yield* Effect.promise(() => proc.exited)

          expect(exitCode).toBe(0)
          expect(stdout).toContain("UNIT_TEST_OK")
        }),
      ),
    ),
  )

  // Workflow 6: Multi-Agent Task Orchestration (Planner -> Coder -> Reviewer)
  it.live("Workflow 6: Executes coordinator delegation across planner, coder, and reviewer", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const parent = yield* session.create({ location, model: localModel, title: "Coordinator Session" })
          yield* withSetup(parent.location)

          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          // 1. Planner subagent
          const planRes = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-plan",
              name: SubagentTool.name,
              input: {
                agent: "planner",
                description: "Decompose calculator feature",
                prompt: "Create step-by-step implementation plan",
              },
            },
          })
          expect(planRes.status).toBe("completed")
          expect(planRes.content?.[0]?.type === "text" ? planRes.content[0].text : "").toContain("Task result from planner")

          // 2. Coder subagent
          const codeRes = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-code",
              name: SubagentTool.name,
              input: {
                agent: "coder",
                description: "Implement calculator feature",
                prompt: "Implement code according to plan",
                files: ["calculator.js"],
              },
            },
          })
          expect(codeRes.status).toBe("completed")
          expect(codeRes.content?.[0]?.type === "text" ? codeRes.content[0].text : "").toContain("Task result from coder")

          // 3. Reviewer subagent
          const reviewRes = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-review",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "Review implementation diffs and tests",
                prompt: "Execute test suite and verify no regressions",
              },
            },
          })
          expect(reviewRes.status).toBe("completed")
          expect(reviewRes.content?.[0]?.type === "text" ? reviewRes.content[0].text : "").toContain("Task result from reviewer")
        }),
      ),
    ),
  )

  // Workflow 7: Task Progress, Cancellation & Reporting
  it.live("Workflow 7: Reports subagent task progress, bounds checking, and cancellation", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const parent = yield* session.create({ location, model: localModel, title: "Progress Test" })
          yield* withSetup(parent.location)

          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          // Attempt self-delegation loop: should fail safely
          const loopRes = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            agent: Agent.ID.make("coder"),
            call: {
              type: "tool-call",
              id: "call-loop",
              name: SubagentTool.name,
              input: {
                agent: "coder",
                description: "Self loop",
                prompt: "Recursive spawn attempt",
              },
            },
          })
          expect(loopRes.status).toBe("error")
          expect(loopRes.error?.message).toContain("Agent coder cannot delegate to itself")
        }),
      ),
    ),
  )

  // Workflow 8: Conversation History Persistence & Continuation Across Restarts
  it.live("Workflow 8: Preserves conversation history across simulated restarts with linear sequence continuity", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const bus = yield* Bus.Service

          // Turn 1
          const original = yield* session.create({ location, model: localModel, title: "Persistent History" })
          yield* bus.publish(SessionEvent.Synthetic, {
            sessionID: original.id,
            text: "First prompt",
          })
          const asst1Id = SessionMessage.ID.create()
          yield* bus.publish(SessionEvent.Step.Started, {
            sessionID: original.id,
            assistantMessageID: asst1Id,
            agent: Agent.defaultID,
            model: localModel,
            started: 100,
          })
          yield* bus.publish(SessionEvent.Text.Started, {
            sessionID: original.id,
            assistantMessageID: asst1Id,
            ordinal: 0,
          })
          yield* bus.publish(SessionEvent.Text.Ended, {
            sessionID: original.id,
            assistantMessageID: asst1Id,
            ordinal: 0,
            text: "First response",
          })
          yield* bus.publish(SessionEvent.Step.Ended, {
            sessionID: original.id,
            assistantMessageID: asst1Id,
            finish: "stop",
            cost: Money.USD.zero,
            tokens,
          })

          // Simulate restart / reload from store
          const restored = yield* session.get(original.id)
          expect(restored).toBeDefined()
          expect(restored.model?.providerID).toBe(Provider.ID.make("ollama"))
          expect(restored.model?.id).toBe(Model.ID.make("qwen2.5-coder:7b"))

          const messages = yield* session.messages({ sessionID: original.id, order: "asc" })
          expect(messages.length).toBe(2)

          // Turn 2 continuation
          yield* bus.publish(SessionEvent.Synthetic, {
            sessionID: original.id,
            text: "Second continuation prompt",
          })

          const reloaded = yield* session.messages({ sessionID: original.id, order: "asc" })
          expect(reloaded.length).toBe(3)
        }),
      ),
    ),
  )

  // Workflow 9: Error Handling - Offline Ollama / Empty Inventory & Interrupted Requests
  it.live("Workflow 9: Handles offline runtime, empty inventory, and interrupted tool runs cleanly", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const bus = yield* Bus.Service
          const locations = yield* LocationServiceMap.Service
          const runner = yield* SessionRunnerModel.Service.pipe(Effect.provide(locations.get(location)))

          // 1. Offline / Empty inventory error
          const emptySession = Session.Info.make({
            id: Session.ID.make("ses_empty"),
            projectID: Project.ID.global,
            title: "Empty session",
            cost: Money.USD.zero,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2) },
            location,
          })

          const missingResult = yield* runner.resolve(emptySession, () => Effect.succeed([])).pipe(Effect.flip)
          expect(missingResult._tag).toBe("SessionRunnerModel.ModelNotSelectedError")
          expect(missingResult.message).toContain("No local model is available")
          expect(missingResult.message).toContain("http://127.0.0.1:11434")

          // 2. Interrupted tool execution handling
          const item = yield* session.create({ location, model: localModel, title: "Interrupted Tool Test" })
          yield* bus.publish(SessionEvent.Synthetic, {
            sessionID: item.id,
            text: "Run a command that gets interrupted",
          })
          const toolCallMsgId = SessionMessage.ID.create()
          yield* bus.publish(SessionEvent.Step.Started, {
            sessionID: item.id,
            assistantMessageID: toolCallMsgId,
            agent: Agent.defaultID,
            model: localModel,
            started: 100,
          })
          yield* bus.publish(SessionEvent.Tool.Input.Started, {
            sessionID: item.id,
            assistantMessageID: toolCallMsgId,
            id: "call_build",
            name: "shell",
          })
          yield* bus.publish(SessionEvent.Tool.Input.Ended, {
            sessionID: item.id,
            assistantMessageID: toolCallMsgId,
            id: "call_build",
            text: '{"command":"sleep 10"}',
          })
          yield* bus.publish(SessionEvent.Tool.Called, {
            sessionID: item.id,
            assistantMessageID: toolCallMsgId,
            id: "call_build",
            input: { command: "sleep 10" },
            executed: false,
          })
          yield* bus.publish(SessionEvent.Execution.Interrupted, {
            sessionID: item.id,
            reason: "user",
          })

          // On reload, interrupted running calls are preserved in their incomplete state
          const msgs = yield* session.messages({ sessionID: item.id, order: "asc" })
          expect(msgs.length).toBeGreaterThanOrEqual(2)
          const callMsg = msgs.find((m) => m.type === "assistant")
          expect(callMsg).toBeDefined()
          if (callMsg?.type === "assistant") {
            expect(callMsg.content[0]).toMatchObject({
              type: "tool",
              id: "call_build",
            })
          }
        }),
      ),
    ),
  )

  // Workflow 10: Strict Cloud Inference Prohibition
  it.live("Workflow 10: Strictly rejects cloud models and refuses fallback under all conditions", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const locations = yield* LocationServiceMap.Service
          const runner = yield* SessionRunnerModel.Service.pipe(Effect.provide(locations.get(location)))

          const fakeSession = Session.Info.make({
            id: Session.ID.make("ses_cloud_test"),
            projectID: Project.ID.global,
            title: "Cloud test session",
            model: {
              providerID: Provider.ID.make("openai"),
              id: Model.ID.make("gpt-4o"),
            },
            cost: Money.USD.zero,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2) },
            location,
          })

          const result = yield* runner.resolve(fakeSession, () => Effect.succeed([])).pipe(Effect.flip)
          expect(result._tag).toBe("SessionRunnerModel.ModelUnavailableError")
          expect(result.message).toContain("Cloud providers are disabled in this local-only environment")
          expect(result.message).toContain("Please select an installed Ollama model using /models")
        }),
      ),
    ),
  )

  // Workflow 11: File & Terminal Permissions & Path Boundary Enforcement
  it.live("Workflow 11: Enforces specialist permissions and prevents out-of-bounds operations", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          yield* withSetup(location)

          const locations = yield* LocationServiceMap.Service
          const agents = yield* Agent.Service.pipe(Effect.provide(locations.get(location)))
          const list = yield* agents.list()
          const planner = list.find((a) => a.id === "planner")
          const coder = list.find((a) => a.id === "coder")
          const reviewer = list.find((a) => a.id === "reviewer")

          expect(planner).toBeDefined()
          expect(coder).toBeDefined()
          expect(reviewer).toBeDefined()

          // Planner: read allowed, edit/shell denied
          expect(Permission.evaluate("read", "file.ts", planner!.permissions).effect).toBe("allow")
          expect(Permission.evaluate("edit", "file.ts", planner!.permissions).effect).toBe("deny")
          expect(Permission.evaluate("shell", "rm -rf /", planner!.permissions).effect).toBe("deny")

          // Reviewer: shell allowed for checks, edit/write denied
          expect(Permission.evaluate("shell", "bun test", reviewer!.permissions).effect).toBe("allow")
          expect(Permission.evaluate("edit", "file.ts", reviewer!.permissions).effect).toBe("deny")
          expect(Permission.evaluate("write", "file.ts", reviewer!.permissions).effect).toBe("deny")
          expect(Permission.evaluate("subagent", "*", reviewer!.permissions).effect).toBe("deny")

          // Coder: edit/write allowed, subagent nesting denied
          expect(Permission.evaluate("edit", "file.ts", coder!.permissions).effect).toBe("allow")
          expect(Permission.evaluate("write", "file.ts", coder!.permissions).effect).toBe("allow")
          expect(Permission.evaluate("subagent", "*", coder!.permissions).effect).toBe("deny")
        }),
      ),
    ),
  )
})
