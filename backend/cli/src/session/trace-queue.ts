import path from "node:path"
import z from "zod"
import type { Database } from "bun:sqlite"
import { Global } from "@/global"
import { Storage } from "@/storage/storage"

/** One durable event row keeps its identity through delivery retries and receipts. */
export namespace TraceQueue {
  export const Route = z.enum(["managed", "byok", "chatgpt", "subscription", "local", "custom"])
  export const Kind = z.enum([
    "model.request",
    "model.response",
    "assistant.message",
    "tool.started",
    "tool.completed",
    "tool.failed",
    "tool.cancelled",
    "error",
  ])
  export const Event = z.object({
    event_id: z.string().uuid(),
    schema_version: z.literal(2),
    event_type: Kind,
    occurred_at: z.string().datetime(),
    installation_id: z.string().uuid(),
    trace_id: z.string(),
    span_id: z.string(),
    parent_span_id: z.string().optional(),
    session_id: z.string(),
    run_id: z.string(),
    model_route: Route,
    provider_id: z.string(),
    model_id: z.string(),
    payload: z.record(z.string(), z.unknown()),
  })
  export const Row = z.object({ account: z.string(), event: Event })
  export type Row = z.infer<typeof Row>
  export const Settings = z.object({
    installation: z
      .string()
      .uuid()
      .default(() => crypto.randomUUID()),
    enabled: z.boolean().default(true),
    revision: z.string().default("initial"),
    batchSize: z.number().int().min(1).max(64).default(64),
    delivered: z.number().int().nonnegative().default(0),
    lastDelivery: z.string().datetime().optional(),
    error: z.string().optional(),
  })
  export const Attempt = z.object({
    deliveryID: z.string(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    state: z.enum(["pending", "response_received", "rejected", "acknowledged", "partial", "unknown"]).catch("unknown"),
  })
  export const Rejection = z.object({ eventID: z.string(), reason: z.string() })
  export const Binding = z.object({
    account: z.string(),
    revision: z.string(),
    credential: z.string().regex(/^[a-f0-9]{64}$/),
    sessionID: z.string(),
    messageID: z.string(),
    route: Route,
    provider: z.string(),
    model: z.string(),
    operationID: z.string().optional(),
  })
  export type Binding = z.infer<typeof Binding>
  const Legacy = Settings.extend({ queue: Row.array().default([]), quarantined: Row.array().default([]) })
  const source = path.join(Global.Path.data, "usage-logging.json")
  const marker = "legacy-usage-logging"
  const state = (db: Database) => {
    const row = db.query<{ data: string }, []>("SELECT data FROM trace_settings WHERE id=1").get()
    if (!row) throw new Error("Trace sharing preference is missing")
    const raw: unknown = JSON.parse(row.data)
    if (
      !raw ||
      typeof raw !== "object" ||
      !["installation", "enabled", "revision", "batchSize", "delivered"].every((key) => Object.hasOwn(raw, key))
    )
      throw new Error("Trace sharing preference is unreadable")
    return Settings.parse(raw)
  }
  const save = (db: Database, value: z.infer<typeof Settings>) => {
    db.query("INSERT INTO trace_settings (id,data) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(
      JSON.stringify(Settings.parse(value)),
    )
  }
  async function database() {
    const store = await Storage.research()
    if (await store.migrated(marker)) return store
    const file = Bun.file(source)
    const legacy = Legacy.parse((await file.exists()) ? await file.json() : {})
    await store.transaction((db) => {
      if (db.query("SELECT 1 FROM migration WHERE name=?").get(marker)) return
      save(db, legacy)
      if (legacy.enabled)
        for (const [status, rows] of [
          ["queued", legacy.queue],
          ["quarantined", legacy.quarantined],
        ] as const) {
          for (const row of rows)
            db.query(
              `INSERT INTO trace_event(id,account,session_id,model_route,data,state,queued_at)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
            ).run(
              row.event.event_id,
              row.account,
              row.event.session_id,
              row.event.model_route,
              JSON.stringify(row.event),
              status,
              Date.parse(row.event.occurred_at),
            )
        }
      db.query("INSERT INTO migration(name,completed_at) VALUES (?,?)").run(marker, Date.now())
    })
    return store
  }
  async function discardBackup() {
    const file = Bun.file(source)
    if (!(await file.exists())) return
    const settings = await read()
    await Bun.write(file, JSON.stringify({ ...settings, queue: [], quarantined: [] }), { mode: 0o600 })
  }
  export async function bind(value: Binding) {
    const item = Binding.parse(value)
    await (
      await database()
    ).transaction((db) => {
      const settings = state(db)
      if (!settings.enabled || settings.revision !== item.revision) return
      db.query(
        `INSERT INTO trace_binding(session_id,message_id,account,model_route,data) VALUES (?,?,?,?,?)
        ON CONFLICT(session_id,message_id) DO UPDATE SET account=excluded.account,model_route=excluded.model_route,data=excluded.data`,
      ).run(item.sessionID, item.messageID, item.account, item.route, JSON.stringify(item))
    })
  }
  export async function binding(sessionID: string, messageID: string) {
    return (await database()).query((db) => {
      const row = db
        .query<{ data: string }, [string, string]>("SELECT data FROM trace_binding WHERE session_id=? AND message_id=?")
        .get(sessionID, messageID)
      return row ? Binding.parse(JSON.parse(row.data)) : undefined
    })
  }
  export async function unbind(sessionID: string, messageID: string) {
    await (
      await database()
    ).transaction((db) =>
      db.query("DELETE FROM trace_binding WHERE session_id=? AND message_id=?").run(sessionID, messageID),
    )
  }
  export async function read() {
    return (await database()).query(state)
  }
  export async function status() {
    return (await database()).query((db) => {
      const settings = state(db)
      const counts = db
        .query<{ queued: number; quarantined: number }, []>(
          `SELECT
        (SELECT COUNT(*) FROM trace_event WHERE state='queued') AS queued,
        (SELECT COUNT(*) FROM trace_event WHERE state='quarantined') AS quarantined`,
        )
        .get()!
      const oldest = db
        .query<{ at: number | null }, []>("SELECT MIN(queued_at) AS at FROM trace_event WHERE state='queued'")
        .get()!
      const attempt = db
        .query<
          { id: string; started_at: number; completed_at: number | null; status: number | null; state: string },
          []
        >(
          "SELECT id,started_at,completed_at,status,state FROM trace_delivery ORDER BY started_at DESC,rowid DESC LIMIT 1",
        )
        .get()
      const rejected = db
        .query<{ id: string; error: string | null }, []>(
          "SELECT id,error FROM trace_event WHERE state='quarantined' ORDER BY sequence DESC LIMIT 1",
        )
        .get()
      const oldestQueuedAt = oldest.at === null ? undefined : new Date(oldest.at).toISOString()
      const lastAttempt = attempt
        ? Attempt.parse({
            deliveryID: attempt.id,
            startedAt: new Date(attempt.started_at).toISOString(),
            ...(attempt.completed_at === null ? {} : { completedAt: new Date(attempt.completed_at).toISOString() }),
            ...(attempt.status === null ? {} : { httpStatus: attempt.status }),
            state: attempt.state,
          })
        : undefined
      const rejection = rejected
        ? {
            eventID: rejected.id,
            reason:
              rejected.error === "local_size_limit" || /^http_[1-5][0-9]{2}$/.test(rejected.error ?? "")
                ? rejected.error!
                : "unknown",
          }
        : undefined
      return {
        ...settings,
        ...counts,
        oldestQueuedAt,
        lastAttempt,
        rejection,
        stalled: oldest.at !== null && Date.now() - oldest.at > 300_000,
      }
    })
  }
  export async function enqueue(row: Row, revision: string) {
    const value = Row.parse(row)
    return (await database()).transaction((db) => {
      const settings = state(db)
      if (!settings.enabled || settings.revision !== revision) return false
      db.query(
        `INSERT INTO trace_event(id,account,session_id,model_route,data,state,queued_at)
        VALUES (?,?,?,?,?,'queued',?) ON CONFLICT(id) DO NOTHING`,
      ).run(
        value.event.event_id,
        value.account,
        value.event.session_id,
        value.event.model_route,
        JSON.stringify(value.event),
        Date.now(),
      )
      return true
    })
  }
  export async function setEnabled(enabled: boolean) {
    await (
      await database()
    ).transaction((db) => {
      const settings = state(db)
      if (settings.enabled !== enabled) settings.revision = crypto.randomUUID()
      settings.enabled = enabled
      settings.error = undefined
      if (!enabled) {
        db.exec("DELETE FROM trace_binding; DELETE FROM trace_delivery; DELETE FROM trace_event")
      }
      save(db, settings)
    })
    await discardBackup()
  }
  export async function clear() {
    await (
      await database()
    ).transaction((db) => db.exec("DELETE FROM trace_binding; DELETE FROM trace_delivery; DELETE FROM trace_event"))
    await discardBackup()
  }
  export async function filter(account: string, managed: boolean, owned: boolean) {
    await (
      await database()
    ).transaction((db) => {
      db.query(
        "DELETE FROM trace_event WHERE account<>? OR (model_route='managed' AND ?=0) OR (model_route<>'managed' AND ?=0)",
      ).run(account, Number(managed), Number(owned))
      db.query(
        "DELETE FROM trace_binding WHERE account<>? OR (model_route='managed' AND ?=0) OR (model_route<>'managed' AND ?=0)",
      ).run(account, Number(managed), Number(owned))
      db.query("DELETE FROM trace_delivery WHERE account<>?").run(account)
      if (!managed) {
        const settings = state(db)
        settings.error = "Trace sharing is disabled by your saved privacy preferences."
        save(db, settings)
      }
    })
    await discardBackup()
  }
  export async function batch(account: string) {
    return (await database()).transaction((db) => {
      const settings = state(db)
      if (!settings.enabled) return []
      const candidates = db
        .query<{ id: string; data: string }, [string, number]>(
          "SELECT id,data FROM trace_event WHERE account=? AND state='queued' ORDER BY sequence LIMIT ?",
        )
        .all(account, settings.batchSize)
      const rows: Row[] = []
      const size = { bytes: 0 }
      for (const item of candidates) {
        const bytes = Buffer.byteLength(item.data)
        if (bytes > 2 * 1024 * 1024) {
          db.query("UPDATE trace_event SET state='quarantined',error='local_size_limit' WHERE id=?").run(item.id)
          settings.error = "A trace record exceeds the delivery size limit and is kept locally."
          save(db, settings)
          continue
        }
        if (size.bytes + bytes > 2 * 1024 * 1024) break
        rows.push({ account, event: Event.parse(JSON.parse(item.data)) })
        size.bytes += bytes
      }
      return rows
    })
  }
  export async function beginDelivery(id: string, account: string, rows: Row[], revision: string) {
    return (await database()).transaction((db) => {
      const settings = state(db)
      if (!settings.enabled || settings.revision !== revision) return false
      db.query("INSERT INTO trace_delivery(id,account,started_at,state) VALUES (?,?,?,'pending')").run(
        id,
        account,
        Date.now(),
      )
      for (const row of rows)
        db.query("INSERT INTO trace_delivery_event(delivery_id,event_id) VALUES (?,?)").run(id, row.event.event_id)
      return true
    })
  }
  export async function response(id: string, status: number) {
    await (
      await database()
    ).transaction((db) =>
      db.query("UPDATE trace_delivery SET status=?,state='response_received' WHERE id=?").run(status, id),
    )
  }
  export async function reject(id: string, rows: Row[], status: number) {
    await (
      await database()
    ).transaction((db) => {
      const settings = state(db)
      settings.batchSize = Math.max(1, Math.floor(rows.length / 2))
      if (rows.length === 1) {
        db.query("UPDATE trace_event SET state='quarantined',error=? WHERE id=? AND state='queued'").run(
          `http_${status}`,
          rows[0]!.event.event_id,
        )
        settings.batchSize = 64
      }
      settings.error = `Trace delivery needs attention (HTTP ${status}). Rejected records are kept locally.`
      db.query("UPDATE trace_delivery SET state='rejected',completed_at=? WHERE id=?").run(Date.now(), id)
      save(db, settings)
    })
  }
  export async function acknowledge(
    id: string,
    accepted: string[],
    replayed: string[],
    complete: boolean,
    revision: string,
  ) {
    await (
      await database()
    ).transaction((db) => {
      const settings = state(db)
      if (!settings.enabled || settings.revision !== revision) return
      const count = { value: 0 }
      for (const event of [...accepted, ...replayed])
        count.value += db
          .query("UPDATE trace_event SET state='acknowledged',error=NULL WHERE id=? AND state='queued'")
          .run(event).changes
      settings.delivered += count.value
      if (count.value) settings.lastDelivery = new Date().toISOString()
      settings.error = complete ? undefined : "Some trace records are awaiting acknowledgement."
      if (complete) settings.batchSize = 64
      db.query("UPDATE trace_delivery SET state=?,completed_at=?,accepted=?,replayed=? WHERE id=?").run(
        complete ? "acknowledged" : "partial",
        Date.now(),
        accepted.length,
        replayed.length,
        id,
      )
      save(db, settings)
    })
  }
  export async function failure(message: string) {
    await (
      await database()
    ).transaction((db) => {
      const settings = state(db)
      settings.error = message
      save(db, settings)
    })
  }
}
