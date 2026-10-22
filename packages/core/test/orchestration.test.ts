import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
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
import { SessionStore } from "@opencode/core/session/store"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Permission } from "@opencode/core/permission"
import { SubagentTool, resetSubagentTracking } from "@opencode/core/tool/plugin/subagent"
import { Tool } from "@opencode/core/tool"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"
import { agentHost, host } from "./plugin/host"

const localModel = Model.Ref.make({ id: Model.ID.make("qwen2.5-coder:7b"), providerID: Provider.ID.make("ollama") })
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

let holdDeferred: Deferred.Deferred<void> | undefined = undefined
export const setHoldDeferred = (d: Deferred.Deferred<void> | undefined) => {
  holdDeferred = d
}

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const complete = Effect.fn("OrchestrationTest.complete")(function* (sessionID: Session.ID) {
        const session = yield* store.get(sessionID)
        if (session?.title?.includes("hold") && holdDeferred) {
          yield* Deferred.await(holdDeferred)
        }
        if (session?.title?.includes("fail")) {
          yield* new SessionRunnerModel.ModelNotSelectedError({ sessionID })
          return
        }
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
  name: "test/orchestration-subagent-plugins",
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
  SessionExecution.node,
  LocationServiceMap.node,
])

const replacements = [
  SessionExecution.node.replace(executionNode),
  Global.node.replace(tempGlobalLayer),
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
        editor.models.update(Provider.ID.make("ollama"), Model.ID.make("qwen2.5-coder:7b"), () => {})
      }),
    ).pipe(Effect.provide(locations.get(location)))
    yield* Agent.Service.use((agents) =>
      AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })),
    ).pipe(Effect.provide(locations.get(location)))
  })

describe("Multi-Agent Orchestration", () => {
  it.live("configures specialist roles with strict boundary permissions", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const parent = yield* session.create({ location, model: localModel, title: "Coordinator session" })
          yield* withSetup(parent.location)

          const locations = yield* LocationServiceMap.Service
          const agent = yield* Agent.Service.pipe(Effect.provide(locations.get(parent.location)))

          // Planner: strictly read-only, denies editing and delegation
          const planner = yield* agent.get(Agent.ID.make("planner"))
          expect(planner).toBeDefined()
          expect(planner?.mode).toBe("subagent")
          expect(Permission.evaluate("read", "src/file.ts", planner!.permissions).effect).toBe("allow")
          expect(Permission.evaluate("grep", "*", planner!.permissions).effect).toBe("allow")
          expect(Permission.evaluate("glob", "*", planner!.permissions).effect).toBe("allow")
          expect(Permission.evaluate("edit", "src/file.ts", planner!.permissions).effect).toBe("deny")
          expect(Permission.evaluate("write", "src/file.ts", planner!.permissions).effect).toBe("deny")
          expect(Permission.evaluate("patch", "src/file.ts", planner!.permissions).effect).toBe("deny")
          expect(Permission.evaluate("subagent", "*", planner!.permissions).effect).toBe("deny")
          expect(Permission.evaluate("question", "*", planner!.permissions).effect).toBe("deny")

          // Coder: has file modification and shell tools, denies delegation
          const coder = yield* agent.get(Agent.ID.make("coder"))
          expect(coder).toBeDefined()
          expect(coder?.mode).toBe("subagent")
          expect(Permission.evaluate("read", "src/file.ts", coder!.permissions).effect).toBe("allow")
          expect(Permission.evaluate("edit", "src/file.ts", coder!.permissions).effect).toBe("allow")
          expect(Permission.evaluate("write", "src/file.ts", coder!.permissions).effect).toBe("allow")
          expect(Permission.evaluate("patch", "src/file.ts", coder!.permissions).effect).toBe("allow")
          expect(Permission.evaluate("shell", "bun test", coder!.permissions).effect).toBe("allow")
          expect(Permission.evaluate("subagent", "*", coder!.permissions).effect).toBe("deny")
          expect(Permission.evaluate("question", "*", coder!.permissions).effect).toBe("deny")

          // Reviewer: read-only on files + shell for verification checks, denies editing and delegation
          const reviewer = yield* agent.get(Agent.ID.make("reviewer"))
          expect(reviewer).toBeDefined()
          expect(reviewer?.mode).toBe("subagent")
          expect(Permission.evaluate("read", "src/file.ts", reviewer!.permissions).effect).toBe("allow")
          expect(Permission.evaluate("grep", "*", reviewer!.permissions).effect).toBe("allow")
          expect(Permission.evaluate("glob", "*", reviewer!.permissions).effect).toBe("allow")
          expect(Permission.evaluate("shell", "bun test", reviewer!.permissions).effect).toBe("allow")
          expect(Permission.evaluate("edit", "src/file.ts", reviewer!.permissions).effect).toBe("deny")
          expect(Permission.evaluate("write", "src/file.ts", reviewer!.permissions).effect).toBe("deny")
          expect(Permission.evaluate("patch", "src/file.ts", reviewer!.permissions).effect).toBe("deny")
          expect(Permission.evaluate("subagent", "*", reviewer!.permissions).effect).toBe("deny")
          expect(Permission.evaluate("question", "*", reviewer!.permissions).effect).toBe("deny")
        }),
      ),
    ),
  )

  it.live("delivers multi-agent orchestration guidance through system prompt", () =>
    Effect.sync(() => {
      const rendered = SessionSystemPrompt.make(["shell", "write", "edit", "subagent"])
      expect(rendered).toContain("Multi-Agent Orchestration")
      expect(rendered).toContain("planner")
      expect(rendered).toContain("coder")
      expect(rendered).toContain("reviewer")
      expect(rendered).toContain("PLAN (planner) -> CODE (coder) -> REVIEW (reviewer)")
      expect(rendered).toContain("Changes Made, Checks Performed, and Unresolved Issues")
    }),
  )

  it.live("successfully delegates sequential tasks from coordinator to specialist subagents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const parent = yield* session.create({ location, model: localModel, title: "Coordinator session" })
          yield* withSetup(parent.location)

          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          // Step 1: Delegate to planner
          const planResult = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-planner",
              name: SubagentTool.name,
              input: {
                agent: "planner",
                description: "Plan feature implementation",
                prompt: "Deconstruct task into bounded execution steps",
              },
            },
          })
          expect(planResult.status).toBe("completed")
          const planText = planResult.content?.[0]
          expect(planText?.type === "text" ? planText.text : "").toContain("Task result from planner")

          // Step 2: Delegate to coder with bounded scope
          const coderResult = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-coder",
              name: SubagentTool.name,
              input: {
                agent: "coder",
                description: "Implement bounded step",
                prompt: "Write implementation adhering to planner task",
                files: ["src/component.ts"],
              },
            },
          })
          expect(coderResult.status).toBe("completed")
          const coderText = coderResult.content?.[0]
          expect(coderText?.type === "text" ? coderText.text : "").toContain("Task result from coder")

          // Step 3: Delegate to reviewer for verification
          const reviewerResult = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-reviewer",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "Review implementation",
                prompt: "Review diffs and run tests on implemented component",
              },
            },
          })
          expect(reviewerResult.status).toBe("completed")
          const reviewerText = reviewerResult.content?.[0]
          expect(reviewerText?.type === "text" ? reviewerText.text : "").toContain("Task result from reviewer")
        }),
      ),
    ),
  )

  it.live("prevents self-delegation loop", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const parent = yield* session.create({ location, model: localModel })
          yield* withSetup(parent.location)

          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          // Attempting self-delegation (calling coder from coder context)
          const result = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            agent: Agent.ID.make("coder"),
            call: {
              type: "tool-call",
              id: "call-self-delegation",
              name: SubagentTool.name,
              input: {
                agent: "coder",
                description: "Self-delegating task",
                prompt: "Attempting loop",
              },
            },
          })

          expect(result.status).toBe("error")
          expect(result.error?.message).toContain("Agent coder cannot delegate to itself")
        }),
      ),
    ),
  )

  it.live("enforces conflicting concurrent file edit protection", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const parent = yield* session.create({ location, model: localModel })
          yield* withSetup(parent.location)

          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          const hold = yield* Deferred.make<void>()
          setHoldDeferred(hold)

          // Launch background subagent with file lease on "src/shared.ts"
          const first = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-bg-task",
              name: SubagentTool.name,
              input: {
                agent: "coder",
                description: "hold background edit",
                prompt: "Modify shared file",
                files: ["src/shared.ts"],
                background: true,
              },
            },
          })
          expect(first.status).toBe("completed")
          expect(first.metadata?.status).toBe("running")

          // Attempting another subagent on the same file while first is active must fail with conflicting access
          const second = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-conflicting-task",
              name: SubagentTool.name,
              input: {
                agent: "coder",
                description: "Conflicting edit",
                prompt: "Also modify shared file",
                files: ["src/shared.ts"],
              },
            },
          })
          expect(second.status).toBe("error")
          expect(second.error?.message).toContain('file "src/shared.ts" is already being modified')

          // But an independent task with disjoint files succeeds
          const independent = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-independent-task",
              name: SubagentTool.name,
              input: {
                agent: "coder",
                description: "Independent edit",
                prompt: "Modify disjoint file",
                files: ["src/independent.ts"],
              },
            },
          })
          expect(independent.status).toBe("completed")

          // Release the hold and let the first background task finish
          yield* Deferred.succeed(hold, undefined)
          setHoldDeferred(undefined)
          yield* Effect.yieldNow
        }),
      ),
    ),
  )

  it.live("enforces subagent total work limit", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const parent = yield* session.create({ location, model: localModel })
          yield* withSetup(parent.location)

          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          // Run up to max tasks limit (default 10)
          for (let i = 0; i < 10; i++) {
            const res = yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: `call-task-${i}`,
                name: SubagentTool.name,
                input: {
                  agent: "coder",
                  description: `Task ${i}`,
                  prompt: `Run task ${i}`,
                },
              },
            })
            expect(res.status).toBe("completed")
          }

          // 11th invocation must fail with total work limit
          const exceeded = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-exceeded",
              name: SubagentTool.name,
              input: {
                agent: "coder",
                description: "Runaway task",
                prompt: "Run task 11",
              },
            },
          })
          expect(exceeded.status).toBe("error")
          expect(exceeded.error?.message).toContain("Subagent task limit reached (10 tasks")
        }),
      ),
    ),
  )

  it.live("strictly forbids passing cloud models to subagents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const parent = yield* session.create({ location, model: localModel })
          yield* withSetup(parent.location)

          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          const cloudAttempt = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-cloud-subagent",
              name: SubagentTool.name,
              input: {
                agent: "coder",
                description: "Cloud coder",
                prompt: "Run on openai",
                model: "openai/gpt-4o",
              },
            },
          })

          expect(cloudAttempt.status).toBe("error")
          expect(cloudAttempt.error?.message).toContain("is not available")
        }),
      ),
    ),
  )
})
