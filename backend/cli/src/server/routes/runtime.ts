import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Identifier } from "../../id/id"
import { RuntimeEvents } from "../../runtime/events"
import { Session } from "../../session"
import { SessionPrompt } from "../../session/prompt"
import { lazy } from "../../util/lazy"
import { Log } from "../../util/log"

const log = Log.create({ service: "runtime-route" })

const PromptInput = z.object({
  sessionID: Identifier.schema("session"),
  message: z.string().trim().min(1).max(1_000_000),
  effort: z.enum(["normal", "ultra"]),
})

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

export const RuntimeRoutes = lazy(() =>
  new Hono()
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
        await Session.get(input.sessionID)
        SessionPrompt.assertNotBusy(input.sessionID)

        const acceptedAt = Date.now()
        const runID = Identifier.ascending("runtime")
        try {
          await RuntimeEvents.begin({
            sessionID: input.sessionID,
            runID,
            acceptedAt,
            effort: input.effort,
          })
        } catch (error) {
          if (error instanceof RuntimeEvents.ActiveRunError) {
            return c.json({ error: "session_busy", message: error.message }, 409)
          }
          throw error
        }

        void SessionPrompt.prompt({
          sessionID: input.sessionID,
          // The stable runtime contract is deliberately smaller than legacy
          // session configuration: every public run enters through Research,
          // even if a migrated install still names hidden Plan as its default.
          agent: "research",
          effort: input.effort,
          parts: [{ type: "text", text: input.message }],
        })
          .then((message) =>
            message.info.role === "assistant" && message.info.error
              ? RuntimeEvents.fail({
                  sessionID: input.sessionID,
                  runID,
                  messageID: message.info.id,
                  error: message.info.error,
                })
              : RuntimeEvents.finish({
                  sessionID: input.sessionID,
                  runID,
                  messageID: message.info.id,
                }),
          )
          .catch(async (error) => {
            // A source-provenanced POST /abort writes runtime.cancelled first.
            // The prompt then settles with MessageAbortedError; do not replace
            // that authoritative cancellation with a generic runtime failure.
            if (error instanceof RuntimeEvents.ActiveRunError) return
            await RuntimeEvents.fail({ sessionID: input.sessionID, runID, error }).catch((journalError) => {
              log.error("failed to record terminal runtime event", { sessionID: input.sessionID, runID, journalError })
            })
          })

        return c.json({ runID, acceptedAt }, 202)
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
    ),
)
