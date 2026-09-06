import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Identifier } from "../../id/id"
import { RuntimeEvents } from "../../runtime/events"
import { Session } from "../../session"
import { lazy } from "@synsci/util/lazy"
import { Flag } from "../../flag/flag"

import { RuntimeRuns } from "../../runtime/runs"
import { RuntimeDecisions } from "../../runtime/decisions"
import { PermissionNext } from "../../permission/next"
import { Question } from "../../question"
import { Installation } from "../../installation"

function cursorError(error: unknown) {
  if (error instanceof RuntimeEvents.CursorExpiredError) {
    return {
      error: "cursor_expired" as const,
      message: error.message,
      oldestSequence: error.oldestSequence,
    }
  }
  if (error instanceof RuntimeEvents.CursorAheadError) {
    return {
      error: "cursor_ahead" as const,
      message: error.message,
      latestSequence: error.latestSequence,
    }
  }
}

/**
 * Move a subscription from its snapshot buffer to live delivery without an
 * await boundary. The loop also handles synchronous re-entrancy, so an event
 * queued while a buffered event is handed off is drained before the live
 * receiver is installed.
 */
export function handoffRuntimeEvents(
  queued: RuntimeEvents.Event[],
  deliver: (event: RuntimeEvents.Event) => void,
  activate: (receive: (event: RuntimeEvents.Event) => void) => void,
) {
  while (queued.length > 0) {
    const pending = queued.splice(0).toSorted((a, b) => a.sequence - b.sequence)
    for (const event of pending) deliver(event)
  }
  activate(deliver)
}

export const RuntimeRoutes = lazy(() => {
  const PromptInput = RuntimeRuns.Input

  const Snapshot = z
    .object({
      sessionID: Identifier.schema("session"),
      runs: RuntimeRuns.Run.array(),
      oldestSequence: z.number().int().positive(),
      latestSequence: z.number().int().nonnegative(),
      permissions: PermissionNext.Request.array(),
      questions: Question.Request.array(),
      decisionScope: z.literal("connected_runtime"),
    })
    .meta({ ref: "RuntimeSnapshot" })

  const Capabilities = z
    .object({
      protocolVersion: z.literal("1.0"),
      serverVersion: z.string(),
      idempotentPrompts: z.literal(true),
      richInputs: z.literal(true),
      runSnapshots: z.literal(true),
      eventRetention: z.number().int().positive(),
      crashRecovery: z.literal("interrupt"),
      decisionScope: z.literal("connected_runtime"),
    })
    .meta({ ref: "RuntimeCapabilities" })

  const PromptAccepted = z
    .object({
      runID: Identifier.schema("runtime"),
      acceptedAt: z.number().int().nonnegative(),
    })
    .meta({ ref: "RuntimePromptAccepted" })

  const CursorQuery = z.object({
    sessionID: Identifier.schema("session"),
    afterSequence: z.coerce.number().int().nonnegative().optional(),
  })

  const Replay = z
    .object({
      events: z.array(RuntimeEvents.Event),
      oldestSequence: z.number().int().positive(),
      latestSequence: z.number().int().nonnegative(),
    })
    .meta({ ref: "RuntimeEventReplay" })

  return new Hono()
    .post(
      "/prompt",
      describeRoute({
        summary: "Start a research run",
        description: "Accepts a prompt and returns immediately while the Research agent continues in the background.",
        operationId: "runtime.prompt",
        responses: {
          202: {
            description: "Run accepted",
            content: { "application/json": { schema: resolver(PromptAccepted) } },
          },
          404: { description: "Session not found" },
          409: { description: "Session already has an active run" },
        },
      }),
      validator("json", PromptInput),
      async (c) => {
        const input = c.req.valid("json")
        // The public runtime remains Research-only. The isolated source lab
        // may opt into the feature-gated thin agent without widening the
        // generated API or making a hidden agent selectable in production.
        const requestedAgent = c.req.header("x-openscience-dev-agent")
        if (
          requestedAgent &&
          !(requestedAgent === "researchagent-test" && Flag.OPENSCIENCE_ENABLE_RESEARCH_AGENT_TEST)
        ) {
          return c.json(
            { error: "dev_agent_unavailable", message: "The requested development agent is unavailable." },
            400,
          )
        }
        const agent = requestedAgent ?? "research"
        try {
          return c.json(await RuntimeRuns.prompt(input, agent), 202)
        } catch (error) {
          if (error instanceof RuntimeRuns.ConflictError)
            return c.json({ error: "request_conflict", message: error.message }, 409)
          if (error instanceof RuntimeEvents.ActiveRunError)
            return c.json({ error: "session_busy", message: error.message }, 409)
          throw error
        }
      },
    )
    .post(
      "/cancel",
      describeRoute({
        summary: "Cancel one research run",
        description:
          "Cancellation is scoped to the run ID. Repeating it cannot stop a later run. Running tools may need time to settle; read the run receipt for terminal state.",
        operationId: "runtime.cancel",
        responses: {
          200: {
            description: "Current run state",
            content: { "application/json": { schema: resolver(RuntimeRuns.Run) } },
          },
          404: { description: "Session or run not found" },
        },
      }),
      validator("json", z.object({ sessionID: Identifier.schema("session"), runID: RuntimeRuns.RunID }).strict()),
      async (c) => {
        const input = c.req.valid("json")
        return c.json(await RuntimeRuns.cancel(input.sessionID, input.runID))
      },
    )
    .post(
      "/decision",
      describeRoute({
        summary: "Resolve a pending runtime decision",
        description:
          "Retries of an identical decision return its stored receipt. A conflicting response is rejected. Only live requests on the connected runtime can be resolved; an indeterminate receipt requires inspecting current state rather than repeating the action.",
        operationId: "runtime.decide",
        responses: {
          200: {
            description: "Decision receipt",
            content: { "application/json": { schema: resolver(RuntimeDecisions.Result) } },
          },
          400: { description: "Invalid answer" },
          404: { description: "Session not found" },
          409: { description: "Conflicting or expired decision" },
        },
      }),
      validator("json", RuntimeDecisions.Input),
      async (c) => {
        try {
          return c.json(await RuntimeDecisions.decide(c.req.valid("json")))
        } catch (error) {
          if (error instanceof RuntimeDecisions.ConflictError)
            return c.json({ error: "decision_conflict", message: error.message }, 409)
          if (error instanceof RuntimeDecisions.ExpiredError)
            return c.json({ error: "decision_expired", message: error.message }, 409)
          if (error instanceof RuntimeDecisions.AnswerError)
            return c.json({ error: "invalid_answer", message: error.message }, 400)
          throw error
        }
      },
    )
    .get(
      "/capabilities",
      describeRoute({
        summary: "Get supported runtime protocol",
        operationId: "runtime.capabilities",
        responses: {
          200: {
            description: "Runtime capabilities",
            content: { "application/json": { schema: resolver(Capabilities) } },
          },
        },
      }),
      (c) =>
        c.json({
          protocolVersion: "1.0" as const,
          serverVersion: Installation.VERSION,
          idempotentPrompts: true as const,
          richInputs: true as const,
          runSnapshots: true as const,
          eventRetention: RuntimeEvents.RETAINED_EVENTS,
          crashRecovery: "interrupt" as const,
          decisionScope: "connected_runtime" as const,
        }),
    )
    .get(
      "/run",
      describeRoute({
        summary: "Get a durable research run",
        description:
          "Returns the authoritative run receipt and terminal result reference, independently of event retention. A dead runtime is interrupted and never automatically retried.",
        operationId: "runtime.getRun",
        responses: {
          200: { description: "Research run", content: { "application/json": { schema: resolver(RuntimeRuns.Run) } } },
          404: { description: "Session or run not found" },
        },
      }),
      validator("query", z.object({ sessionID: Identifier.schema("session"), runID: RuntimeRuns.RunID })),
      async (c) => {
        const input = c.req.valid("query")
        return c.json(await RuntimeRuns.get(input.sessionID, input.runID))
      },
    )
    .get(
      "/snapshot",
      describeRoute({
        summary: "Resynchronize a research session",
        description:
          "Returns durable run receipts, an event cursor and live pending decisions belonging to this server process. Replayed decision events are historical; only pending requests in a fresh snapshot are actionable.",
        operationId: "runtime.snapshot",
        responses: {
          200: { description: "Runtime snapshot", content: { "application/json": { schema: resolver(Snapshot) } } },
          404: { description: "Session not found" },
        },
      }),
      validator("query", z.object({ sessionID: Identifier.schema("session") })),
      async (c) => {
        const { sessionID } = c.req.valid("query")
        await Session.get(sessionID)
        // Read the cursor before state so changes racing this snapshot can be
        // replayed afterwards; consumers deduplicate by sequence/identity.
        const replay = await RuntimeEvents.replay(sessionID)
        const [runs, permissions, questions] = await Promise.all([
          RuntimeRuns.list(sessionID),
          PermissionNext.list(),
          Question.list(),
        ])
        return c.json({
          sessionID,
          runs,
          oldestSequence: replay.oldestSequence,
          latestSequence: replay.latestSequence,
          permissions: permissions.filter((item) => item.sessionID === sessionID),
          questions: questions.filter((item) => item.sessionID === sessionID),
          decisionScope: "connected_runtime" as const,
        })
      },
    )
    .get(
      "/events/replay",
      describeRoute({
        summary: "Replay research run events",
        description: "Returns retained events strictly after the supplied per-session sequence cursor.",
        operationId: "runtime.replay",
        responses: {
          200: {
            description: "Retained event window",
            content: { "application/json": { schema: resolver(Replay) } },
          },
          409: { description: "Cursor is outside the retained event window" },
        },
      }),
      validator("query", CursorQuery),
      async (c) => {
        const input = c.req.valid("query")
        return RuntimeEvents.replay(input.sessionID, input.afterSequence)
          .then((result) => c.json(result))
          .catch((error) => {
            const body = cursorError(error)
            if (body) return c.json(body, 409)
            throw error
          })
      },
    )
    .get(
      "/events",
      describeRoute({
        summary: "Subscribe to research run events",
        description:
          "Replays retained events after a cursor, then streams live events with SSE id fields equal to their sequence numbers.",
        operationId: "runtime.subscribe",
        responses: {
          200: {
            description: "Sequenced runtime event stream",
            content: { "text/event-stream": { schema: resolver(RuntimeEvents.Event) } },
          },
          409: { description: "Cursor is outside the retained event window" },
        },
      }),
      validator("query", CursorQuery),
      async (c) => {
        const input = c.req.valid("query")
        const header = c.req.header("Last-Event-ID")
        const headerCursor = header === undefined || header === "" ? undefined : Number(header)
        if (headerCursor !== undefined && (!Number.isInteger(headerCursor) || headerCursor < 0)) {
          return c.json({ error: "invalid_cursor", message: "Last-Event-ID must be a non-negative integer" }, 400)
        }
        // Last-Event-ID advances on each automatic SDK reconnect, while the
        // original query string does not. Prefer the header when both exist.
        const afterSequence = headerCursor ?? input.afterSequence

        // Subscribe before reading the snapshot. Anything appended during the
        // read is queued and de-duplicated by sequence after replay, closing the
        // usual snapshot-to-live race without changing the existing /event API.
        const queued: RuntimeEvents.Event[] = []
        let receive = (event: RuntimeEvents.Event) => {
          queued.push(event)
        }
        const unsubscribe = RuntimeEvents.subscribe(input.sessionID, (event) => receive(event))
        const replay = await RuntimeEvents.replay(input.sessionID, afterSequence).catch((error) => {
          unsubscribe()
          const body = cursorError(error)
          if (body) return body
          throw error
        })
        if (!("events" in replay)) return c.json(replay, 409)

        return streamSSE(c, async (stream) => {
          let last = afterSequence ?? replay.oldestSequence - 1
          let writes = Promise.resolve()
          const send = (event: RuntimeEvents.Event) => {
            if (event.sequence <= last) return writes
            last = event.sequence
            writes = writes.then(() =>
              stream.writeSSE({
                id: String(event.sequence),
                event: event.type,
                data: JSON.stringify(event),
              }),
            )
            return writes
          }

          for (const event of replay.events) void send(event)
          await writes
          handoffRuntimeEvents(
            queued,
            (event) => void send(event),
            (live) => {
              receive = live
            },
          )
          await writes

          const heartbeat = setInterval(() => {
            // A comment keeps proxies and WKWebView alive without yielding a
            // fake value into the typed RuntimeEvent stream.
            writes = writes.then(async () => {
              await stream.write(": heartbeat\n\n")
            })
          }, 30_000)

          await new Promise<void>((resolve) => {
            stream.onAbort(() => {
              clearInterval(heartbeat)
              unsubscribe()
              resolve()
            })
          })
        })
      },
    )
})
