import { describe, expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { Money } from "@opencode/schema/money"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)

const projectLocation = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const ollamaModel7b = Model.Ref.make({
  id: Model.ID.make("qwen2.5-coder:7b"),
  providerID: Provider.ID.make("ollama"),
})
const ollamaModel14b = Model.Ref.make({
  id: Model.ID.make("qwen2.5-coder:14b"),
  providerID: Provider.ID.make("ollama"),
})

describe("Conversation History & Persistence", () => {
  it.effect("creates a session with local model, timestamps, and persists metadata", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({
        location: projectLocation,
        title: "Local Refactoring Task",
        model: ollamaModel7b,
      })

      expect(created.id).toBeDefined()
      expect(created.title).toBe("Local Refactoring Task")
      expect(created.location.directory).toBe(projectLocation.directory)
      expect(created.model).toMatchObject({
        id: "qwen2.5-coder:7b",
        providerID: "ollama",
      })
      expect(created.time.created).toBeDefined()
      expect(created.time.updated).toBeDefined()

      const retrieved = yield* session.get(created.id)
      expect(retrieved.id).toBe(created.id)
      expect(retrieved.title).toBe("Local Refactoring Task")
      expect(retrieved.model).toMatchObject({
        id: "qwen2.5-coder:7b",
        providerID: "ollama",
      })
    }),
  )

  it.effect("persists conversation state across restarts and allows continuation with linear sequence", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service

      const created = yield* session.create({
        location: projectLocation,
        title: "Session Persistence Test",
        model: ollamaModel7b,
      })
      const sessionID = created.id

      yield* bus.publish(SessionEvent.Synthetic, {
        sessionID,
        text: "Please write a test runner in python",
      })

      const assistantMessageID = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model: ollamaModel7b,
        started: 100,
      })
      yield* bus.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID,
        ordinal: 0,
      })
      yield* bus.publish(SessionEvent.Text.Ended, {
        sessionID,
        assistantMessageID,
        ordinal: 0,
        text: "I will check the directory contents first.",
      })
      yield* bus.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID,
        id: "call_read_dir",
        name: "read_dir",
      })
      yield* bus.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        assistantMessageID,
        id: "call_read_dir",
        text: '{"path":"."}',
      })
      yield* bus.publish(SessionEvent.Tool.Called, {
        sessionID,
        assistantMessageID,
        id: "call_read_dir",
        input: { path: "." },
        executed: false,
      })
      yield* bus.publish(SessionEvent.Tool.Success, {
        sessionID,
        assistantMessageID,
        id: "call_read_dir",
        content: [{ type: "text", text: "runner.py\ntest_runner.py" }],
        executed: false,
      })
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID,
        finish: "stop",
        cost: 0 as Money.USD,
        tokens: {
          input: 25,
          output: 50,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      })

      const persistedSession = yield* store.get(sessionID)
      expect(persistedSession).toBeDefined()
      expect(persistedSession?.title).toBe("Session Persistence Test")
      expect(persistedSession?.model).toMatchObject({
        id: "qwen2.5-coder:7b",
        providerID: "ollama",
      })

      const initialHistory = yield* session.messages({ sessionID, order: "asc" })
      expect(initialHistory).toHaveLength(2)

      const firstMessage = initialHistory[0]
      expect(firstMessage?.type).toBe("synthetic")
      if (firstMessage?.type === "synthetic") {
        expect(firstMessage.text).toBe("Please write a test runner in python")
      }

      const secondMessage = initialHistory[1]
      expect(secondMessage?.type).toBe("assistant")
      if (secondMessage?.type === "assistant") {
        expect(secondMessage.model).toMatchObject({
          id: "qwen2.5-coder:7b",
          providerID: "ollama",
        })
        expect(secondMessage.content).toHaveLength(2)
        expect(secondMessage.content[0]).toMatchObject({
          type: "text",
          text: "I will check the directory contents first.",
        })
        expect(secondMessage.content[1]).toMatchObject({
          type: "tool",
          id: "call_read_dir",
          name: "read_dir",
          state: {
            status: "completed",
            input: { path: "." },
          },
        })
      }

      yield* bus.publish(SessionEvent.Synthetic, {
        sessionID,
        text: "Now run the tests",
      })

      const updatedHistory = yield* store.messages({ sessionID, order: "asc" })
      expect(updatedHistory).toHaveLength(3)

      const thirdMessage = updatedHistory[2]
      expect(thirdMessage?.type).toBe("synthetic")
      if (thirdMessage?.type === "synthetic") {
        expect(thirdMessage.text).toBe("Now run the tests")
      }

      const storedContext = yield* store.context(sessionID)
      expect(storedContext).toHaveLength(3)
    }),
  )

  it.effect("handles interrupted generations and marks stale running tool calls as aborted errors", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service

      const created = yield* session.create({
        location: projectLocation,
        title: "Interrupted Task",
        model: ollamaModel7b,
      })
      const sessionID = created.id

      yield* bus.publish(SessionEvent.Synthetic, {
        sessionID,
        text: "Execute a long running build",
      })

      const assistantMessageID = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model: ollamaModel7b,
        started: 100,
      })
      yield* bus.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID,
        id: "call_build",
        name: "shell",
      })
      yield* bus.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        assistantMessageID,
        id: "call_build",
        text: '{"command":"make build"}',
      })
      yield* bus.publish(SessionEvent.Tool.Called, {
        sessionID,
        assistantMessageID,
        id: "call_build",
        input: { command: "make build" },
        executed: false,
      })

      const midRunMessages = yield* store.messages({ sessionID, order: "asc" })
      expect(midRunMessages).toHaveLength(2)
      const midAssistant = midRunMessages[1]
      expect(midAssistant?.type).toBe("assistant")
      if (midAssistant?.type === "assistant") {
        expect(midAssistant.content[0]).toMatchObject({
          type: "tool",
          id: "call_build",
          state: { status: "running" },
        })
      }

      yield* bus.publish(SessionEvent.Tool.Failed, {
        sessionID,
        assistantMessageID,
        id: "call_build",
        error: { type: "aborted", message: "Tool execution interrupted: user cancelled" },
        executed: false,
      })
      yield* bus.publish(SessionEvent.Execution.Interrupted, {
        sessionID,
        reason: "user",
      })

      const postInterruptedMessages = yield* store.messages({ sessionID, order: "asc" })
      expect(postInterruptedMessages).toHaveLength(3)

      const settledAssistant = postInterruptedMessages[1]
      expect(settledAssistant?.type).toBe("assistant")
      if (settledAssistant?.type === "assistant") {
        const toolItem = settledAssistant.content[0]
        expect(toolItem).toMatchObject({
          type: "tool",
          id: "call_build",
          state: {
            status: "error",
            error: {
              type: "aborted",
              message: "Tool execution interrupted: user cancelled",
            },
          },
        })
        if (toolItem?.type === "tool") {
          expect(toolItem.state.status).not.toBe("completed")
          expect(toolItem.state.status).toBe("error")
        }
      }

      const idleMessage = postInterruptedMessages[2]
      expect(idleMessage?.type).toBe("idle")
      if (idleMessage?.type === "idle") {
        expect(idleMessage.outcome).toBe("interrupted")
      }

      const sessionAfterInterrupt = yield* session.get(sessionID)
      expect(sessionAfterInterrupt.outcome).toBe("interrupted")
    }),
  )

  it.effect("restores and switches local models, persisting the selection across reads", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const store = yield* SessionStore.Service

      const created = yield* session.create({
        location: projectLocation,
        title: "Model Switching Test",
        model: ollamaModel7b,
      })
      const sessionID = created.id

      expect((yield* session.get(sessionID)).model).toMatchObject({
        id: "qwen2.5-coder:7b",
        providerID: "ollama",
      })

      yield* session.switchModel({
        sessionID,
        model: ollamaModel14b,
      })

      const updated = yield* session.get(sessionID)
      expect(updated.model).toMatchObject({
        id: "qwen2.5-coder:14b",
        providerID: "ollama",
      })

      const storeRecord = yield* store.get(sessionID)
      expect(storeRecord?.model).toMatchObject({
        id: "qwen2.5-coder:14b",
        providerID: "ollama",
      })

      const messages = yield* session.messages({ sessionID, order: "asc" })
      expect(messages).toHaveLength(1)
      expect(messages[0]?.type).toBe("model-switched")
      if (messages[0]?.type === "model-switched") {
        expect(messages[0].model).toMatchObject({
          id: "qwen2.5-coder:14b",
          providerID: "ollama",
        })
        expect(messages[0].previous).toMatchObject({
          id: "qwen2.5-coder:7b",
          providerID: "ollama",
        })
      }

      yield* session.switchModel({
        sessionID,
        model: ollamaModel14b,
      })

      const duplicateCheckMessages = yield* session.messages({ sessionID, order: "asc" })
      expect(duplicateCheckMessages).toHaveLength(1)
    }),
  )

  it.effect("provides clean empty states, cursor error recovery, and missing session errors", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const store = yield* SessionStore.Service

      const emptyListing = yield* session.list({ directory: projectLocation.directory })
      expect(emptyListing.data).toEqual([])
      expect(emptyListing.cursor).toEqual({ previous: undefined, next: undefined })

      const emptyStoreListing = yield* store.list({ directory: projectLocation.directory })
      expect(emptyStoreListing).toEqual([])

      const invalidCursorError = yield* session
        .list({ cursor: Schema.decodeSync(Session.ListCursor)("not_a_valid_cursor") })
        .pipe(Effect.flip)
      expect(invalidCursorError).toBeInstanceOf(Session.InvalidListCursorError)

      const nonExistentID = Session.ID.make("ses_does_not_exist")
      const notFoundError = yield* session.get(nonExistentID).pipe(Effect.flip)
      expect(notFoundError).toBeInstanceOf(Session.NotFoundError)

      const emptyMessages = yield* store.messages({ sessionID: nonExistentID })
      expect(emptyMessages).toEqual([])
    }),
  )
})
