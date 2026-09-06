import { Database } from "bun:sqlite"
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import path from "node:path"
import { HTTPFailure, type Decision, type Run, type Runtime, type Slack, type Snapshot } from "./runtime"

export type Binding = { team: string; channel: string; user: string; project: string }
export type Config = { appID: string; botID: string; signingSecret: string; bindings: Binding[]; resultBaseURL: string }
type Thread = Binding & { key: string; thread: string; session: string | null; phase: string; cursor: number }
type Inbox = { id: string; thread: string; text: string; operation: string | null; phase: string }
type Outbox = { key: string; thread: string; text: string; phase: string }
type Operation =
  { kind: "prompt"; message: string } | { kind: "cancel"; runID: string } | { kind: "decision"; input: Decision }

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
function value(input: unknown) {
  return typeof input === "string" ? input : ""
}
function escaped(input: string) {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export function verify(raw: Uint8Array, headers: Headers, secret: string, now = Date.now()) {
  const timestamp = headers.get("x-slack-request-timestamp") ?? ""
  const signature = headers.get("x-slack-signature") ?? ""
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(now / 1_000 - Number(timestamp)) > 300 ||
    !/^v0=[a-f0-9]{64}$/.test(signature)
  )
    return false
  const expected = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:`).update(raw).digest("hex")
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}

/** One worker/process owns this SQLite database. index.ts enforces a process lock. */
export class App {
  readonly db: Database
  private busy = false
  constructor(
    readonly config: Config,
    database: string,
    private runtime: Runtime,
    private slack: Slack,
    private now = Date.now,
  ) {
    if (
      !config.signingSecret ||
      !/^[A-Z0-9]+$/.test(config.botID) ||
      !/^[A-Z0-9]+$/.test(config.appID) ||
      !config.bindings.length
    )
      throw new Error("Signing secret, app/bot IDs and explicit bindings are required")
    const seen = new Set<string>()
    if (new Set(config.bindings.map((binding) => binding.team)).size !== 1)
      throw new Error("Use one installed Slack workspace per starter and bot token")
    for (const binding of config.bindings) {
      if (
        ![binding.team, binding.channel, binding.user].every((id) => /^[A-Z0-9]+$/.test(id)) ||
        !path.isAbsolute(binding.project)
      )
        throw new Error("Bindings need exact Slack IDs and absolute server project paths")
      const key = [binding.team, binding.channel, binding.user].join("/")
      if (seen.has(key)) throw new Error("Ambiguous duplicate principal binding")
      seen.add(key)
    }
    const result = new URL(config.resultBaseURL)
    if (
      !["http:", "https:"].includes(result.protocol) ||
      result.username ||
      result.password ||
      result.search ||
      result.hash
    )
      throw new Error("Result base URL must be a trusted HTTP(S) runtime URL")
    this.db = new Database(database, { create: true, strict: true })
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS threads (key TEXT PRIMARY KEY, team TEXT, channel TEXT, user TEXT, project TEXT, thread TEXT, session TEXT, phase TEXT, cursor INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, thread TEXT, text TEXT, fingerprint TEXT, operation TEXT, phase TEXT);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, thread TEXT, event TEXT UNIQUE, state TEXT, receipt TEXT, result_url TEXT);
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, thread TEXT, kind TEXT, payload TEXT, phase TEXT);
      CREATE TABLE IF NOT EXISTS outbox (key TEXT PRIMARY KEY, thread TEXT, text TEXT, phase TEXT, slack_ts TEXT, detail TEXT);
      UPDATE threads SET phase='indeterminate' WHERE phase='creating';
      UPDATE outbox SET phase='indeterminate', detail='Process stopped during delivery; inspect Slack before any manual retry' WHERE phase='sending';`)
  }
  close() {
    this.db.close()
  }
  private thread(key: string) {
    return this.db.query<Thread, [string]>("SELECT * FROM threads WHERE key=?").get(key)
  }
  private allowed(thread: Thread) {
    return this.config.bindings.some(
      (binding) =>
        binding.team === thread.team &&
        binding.channel === thread.channel &&
        binding.user === thread.user &&
        binding.project === thread.project,
    )
  }
  private queue(key: string, thread: string, text: string) {
    this.db
      .query("INSERT OR IGNORE INTO outbox(key,thread,text,phase) VALUES(?,?,?,'pending')")
      .run(key, thread, text.slice(0, 3500))
  }

  async handle(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/slack/events")
      return new Response("Not found", { status: 404 })
    const raw = new Uint8Array(await request.arrayBuffer())
    if (raw.length > 65_536) return new Response("Request too large", { status: 413 })
    if (!verify(raw, request.headers, this.config.signingSecret, this.now()))
      return new Response("Unauthorized", { status: 401 })
    const payload = object(await new Response(raw).json().catch(() => null))
    if (payload.type === "url_verification" && typeof payload.challenge === "string")
      return Response.json({ challenge: payload.challenge })
    const event = object(payload.event)
    if (payload.type !== "event_callback" || event.type !== "app_mention" || event.bot_id || event.subtype)
      return Response.json({ ignored: true })
    if (
      payload.api_app_id !== this.config.appID ||
      payload.is_ext_shared_channel === true ||
      event.is_ext_shared_channel === true
    )
      return new Response("Forbidden", { status: 403 })
    const binding = this.config.bindings.find(
      (item) => item.team === payload.team_id && item.channel === event.channel && item.user === event.user,
    )
    if (!binding) return new Response("Forbidden", { status: 403 })
    const id = value(payload.event_id)
    const stamp = value(event.thread_ts) || value(event.ts)
    const prefix = `<@${this.config.botID}>`
    const text = value(event.text)
    if (!/^Ev[A-Za-z0-9_-]+$/.test(id) || !/^\d+\.\d+$/.test(stamp) || !text.startsWith(prefix))
      return new Response("Invalid event", { status: 400 })
    const command = text.slice(prefix.length).trim()
    if (!command || command.length > 20_000) return new Response("Invalid command", { status: 400 })
    const key = [binding.team, binding.channel, stamp].join("/")
    const thread = this.thread(key)
    if (thread && (thread.user !== binding.user || thread.project !== binding.project))
      return new Response("Thread belongs to another principal", { status: 403 })
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ key, user: binding.user, command }))
      .digest("hex")
    const prior = this.db.query<{ fingerprint: string }, [string]>("SELECT fingerprint FROM inbox WHERE id=?").get(id)
    if (prior)
      return new Response(prior.fingerprint === fingerprint ? "Already received" : "Event ID conflict", {
        status: prior.fingerprint === fingerprint ? 200 : 409,
      })
    this.db.transaction(() => {
      this.db
        .query("INSERT OR IGNORE INTO threads(key,team,channel,user,project,thread,phase) VALUES(?,?,?,?,?,?,'new')")
        .run(key, binding.team, binding.channel, binding.user, binding.project, stamp)
      this.db
        .query("INSERT INTO inbox(id,thread,text,fingerprint,phase) VALUES(?,?,?,?,'queued')")
        .run(id, key, command, fingerprint)
    })()
    // No network/model work before acknowledgement. The persisted inbox is drained by tick().
    return Response.json({ accepted: true })
  }

  private async session(thread: Thread) {
    if (thread.session) return thread.session
    if (thread.phase === "indeterminate")
      throw new Error("Session creation is indeterminate; operator inspection required")
    this.db.query("UPDATE threads SET phase='creating' WHERE key=?").run(thread.key)
    try {
      const session = await this.runtime.create(thread.project)
      if (!session.id) throw new Error("Missing session ID")
      this.db.query("UPDATE threads SET session=?,phase='active' WHERE key=?").run(session.id, thread.key)
      thread.session = session.id
      return session.id
    } catch {
      this.db.query("UPDATE threads SET phase='indeterminate' WHERE key=?").run(thread.key)
      throw new Error("Session creation was not confirmed; inspect runtime sessions before rebinding")
    }
  }

  private async operation(row: Inbox, thread: Thread): Promise<Operation | undefined> {
    if (row.operation) return JSON.parse(row.operation) as Operation
    const [command, id, ...rest] = row.text.split(/\s+/)
    if (command === "research" && row.text.slice(8).trim()) return { kind: "prompt", message: row.text.slice(8).trim() }
    if (!thread.session) throw new Error("Start this thread with: research <objective>")
    if (command === "status") {
      await this.reconcile(thread)
      const runs = this.db
        .query<{ id: string; state: string }, [string]>("SELECT id,state FROM runs WHERE thread=?")
        .all(thread.key)
      this.queue(
        `command:${row.id}`,
        thread.key,
        runs.map((run) => `${run.id}: ${run.state}`).join("\n") || "No runs submitted by this thread.",
      )
      return
    }
    if (command === "cancel" && id && rest.length === 0) {
      const owned = this.db.query("SELECT id FROM runs WHERE id=? AND thread=?").get(id, thread.key)
      if (!owned) throw new Error("This run is not owned by this thread")
      return { kind: "cancel", runID: id }
    }
    if (!["permission", "answer", "reject"].includes(command) || !id)
      throw new Error(
        "Commands: research <objective>; status; cancel <run>; permission <id> once|reject; answer <id> <JSON string[][]>; reject <question-id>",
      )
    const snapshot = await this.runtime.snapshot(thread.project, thread.session)
    const mapped = this.db
      .query<{ kind: string }, [string, string]>(
        "SELECT kind FROM decisions WHERE id=? AND thread=? AND phase='pending'",
      )
      .get(id, thread.key)
    const permission =
      mapped?.kind === "permission" &&
      snapshot.permissions.some((item) => item.id === id && item.sessionID === thread.session)
    const question =
      mapped?.kind === "question" &&
      snapshot.questions.some((item) => item.id === id && item.sessionID === thread.session)
    if (command === "permission" && permission && rest.length === 1 && ["once", "reject"].includes(rest[0]))
      return {
        kind: "decision",
        input: { sessionID: thread.session, requestID: id, kind: "permission", reply: rest[0] },
      }
    if (command === "reject" && question && rest.length === 0)
      return { kind: "decision", input: { sessionID: thread.session, requestID: id, kind: "question_reject" } }
    if (command === "answer" && question) {
      const answers: unknown = JSON.parse(row.text.match(/^answer\s+\S+\s+([\s\S]+)$/)?.[1] ?? "")
      if (
        Array.isArray(answers) &&
        answers.every((row) => Array.isArray(row) && row.every((item) => typeof item === "string"))
      )
        return { kind: "decision", input: { sessionID: thread.session, requestID: id, kind: "question", answers } }
    }
    throw new Error(
      "Decision is not pending for this thread, or response is invalid; only once/reject permission grants are supported",
    )
  }

  private async process(row: Inbox) {
    const thread = this.thread(row.thread)
    if (!thread || !this.allowed(thread)) {
      // Retain the command as evidence, but do not leave it at the head of
      // every bounded batch or resume it if the principal is later reallowed.
      this.db.query("UPDATE inbox SET phase='revoked' WHERE id=?").run(row.id)
      return
    }
    try {
      const operation = await this.operation(row, thread)
      if (!operation) {
        this.db.query("UPDATE inbox SET phase='processed' WHERE id=?").run(row.id)
        return
      }
      const session = await this.session(thread)
      this.db.query("UPDATE inbox SET operation=?,phase='submitting' WHERE id=?").run(JSON.stringify(operation), row.id)
      if (operation.kind === "prompt") {
        const receipt = await this.runtime.prompt(thread.project, {
          sessionID: session,
          requestID: row.id,
          message: operation.message,
          effort: "normal",
        })
        this.db.transaction(() => {
          this.db
            .query("INSERT OR IGNORE INTO runs(id,thread,event,state,receipt) VALUES(?,?,?,'accepted',?)")
            .run(receipt.runID, thread.key, row.id, JSON.stringify(receipt))
          this.queue(`accepted:${receipt.runID}`, thread.key, `Research accepted: ${receipt.runID}`)
          this.db.query("UPDATE inbox SET phase='processed' WHERE id=?").run(row.id)
        })()
        return
      }
      if (operation.kind === "cancel") {
        const run = await this.runtime.cancel(thread.project, session, operation.runID)
        this.queue(
          `command:${row.id}`,
          thread.key,
          `Cancellation requested for ${run.runID}; current state: ${run.state}. Running tools may still be settling.`,
        )
      } else {
        const receipt = await this.runtime.decide(thread.project, operation.input)
        this.db
          .query("UPDATE decisions SET phase=? WHERE id=? AND thread=?")
          .run(receipt.status, operation.input.requestID, thread.key)
        this.queue(`command:${row.id}`, thread.key, `Decision ${operation.input.requestID}: ${receipt.status}.`)
      }
      this.db.query("UPDATE inbox SET phase='processed' WHERE id=?").run(row.id)
    } catch (error) {
      // Persisted submissions may recover only through the same runtime
      // idempotency key/payload. A known rejection is not retried as new work.
      const current = this.db.query<{ phase: string }, [string]>("SELECT phase FROM inbox WHERE id=?").get(row.id)
      if (
        current?.phase === "submitting" &&
        (!(error instanceof HTTPFailure) || error.status >= 500 || error.status === 429)
      )
        return
      this.db.query("UPDATE inbox SET phase='failed' WHERE id=?").run(row.id)
      this.queue(
        `error:${row.id}`,
        thread.key,
        error instanceof HTTPFailure
          ? error.message
          : "Command could not be completed. Check the local adapter state and use status before submitting new work.",
      )
    }
  }

  private result(thread: Thread, run: Run) {
    if (!run.resultMessageID) return null
    const url = new URL(
      this.config.resultBaseURL.replace(/\/$/, "") +
        `/session/${encodeURIComponent(run.sessionID)}/message/${encodeURIComponent(run.resultMessageID)}`,
    )
    url.searchParams.set("directory", thread.project)
    return url.toString()
  }

  private async reconcile(thread: Thread) {
    if (!thread.session) return
    const snapshot = await this.runtime.snapshot(thread.project, thread.session)
    const replay = await this.runtime.replay(thread.project, thread.session, thread.cursor).catch((error) => {
      if (error instanceof HTTPFailure && ["cursor_expired", "cursor_ahead"].includes(error.code)) return undefined
      throw error
    })
    if (replay) {
      const fresh = replay.events.filter((event) => event.sequence > thread.cursor)
      if (fresh.some((event, index) => event.sequence !== thread.cursor + index + 1))
        this.queue(
          `resync:${thread.key}:${thread.cursor}`,
          thread.key,
          "Runtime event gap detected. State was resynchronized from the durable snapshot; no work was resubmitted.",
        )
    }
    // Snapshot precedes replay. Commit only its earlier cursor so events racing
    // the snapshot remain available on the next poll instead of being skipped.
    this.db.transaction(() => {
      for (const run of snapshot.runs) {
        if (!this.db.query("SELECT id FROM runs WHERE id=? AND thread=?").get(run.runID, thread.key)) continue
        const result = this.result(thread, run)
        this.db.query("UPDATE runs SET state=?,result_url=? WHERE id=?").run(run.state, result, run.runID)
        if (!["accepted", "running"].includes(run.state))
          this.queue(
            `terminal:${run.runID}`,
            thread.key,
            `${run.runID}: ${run.state}.${result ? ` Result and artifact references (runtime authentication required): ${result}` : ""}${run.state === "interrupted" ? " Inspect outputs before explicitly starting new work; this run will not be restarted automatically." : ""}`,
          )
      }
      this.db.query("UPDATE decisions SET phase='historical' WHERE thread=? AND phase='pending'").run(thread.key)
      const active = snapshot.runs.some(
        (run) =>
          ["accepted", "running"].includes(run.state) &&
          this.db.query("SELECT id FROM runs WHERE id=? AND thread=?").get(run.runID, thread.key),
      )
      if (active)
        for (const [kind, pending] of [
          ["permission", snapshot.permissions],
          ["question", snapshot.questions],
        ] as const) {
          for (const item of pending) {
            if (item.sessionID !== thread.session) continue
            this.db
              .query(
                "INSERT INTO decisions(id,thread,kind,payload,phase) VALUES(?,?,?,?,'pending') ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,phase='pending' WHERE decisions.thread=excluded.thread",
              )
              .run(item.id, thread.key, kind, JSON.stringify(item))
            const detail =
              kind === "permission"
                ? `${item.permission ?? "tool access"}: ${(item.patterns ?? []).join(", ")}. Reply: permission ${item.id} once (or reject).`
                : `${JSON.stringify(item.questions)}. Reply: answer ${item.id} <JSON string[][]> (or reject ${item.id}).`
            this.queue(`pending:${item.id}`, thread.key, `Pending ${kind} ${item.id}. ${detail}`)
          }
        }
      this.db.query("UPDATE threads SET cursor=? WHERE key=?").run(snapshot.latestSequence, thread.key)
    })()
  }

  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      for (const row of this.db
        .query<Inbox, []>("SELECT * FROM inbox WHERE phase IN ('queued','submitting') ORDER BY rowid LIMIT 20")
        .all())
        await this.process(row)
      for (const thread of this.db.query<Thread, []>("SELECT * FROM threads WHERE phase='active'").all()) {
        if (this.allowed(thread)) await this.reconcile(thread).catch(() => undefined)
      }
      const delivered = new Set<string>()
      for (const row of this.db
        .query<Outbox, []>("SELECT * FROM outbox WHERE phase='pending' ORDER BY rowid LIMIT 20")
        .all()) {
        const thread = this.thread(row.thread)
        if (!thread || !this.allowed(thread)) {
          this.db
            .query(
              "UPDATE outbox SET phase='revoked',detail='Principal binding was removed before delivery' WHERE key=?",
            )
            .run(row.key)
          continue
        }
        // The entry point ticks every two seconds; one send per channel per
        // tick stays below Slack's ordinary per-channel message rate.
        if (delivered.has(thread.channel)) continue
        delivered.add(thread.channel)
        this.db.query("UPDATE outbox SET phase='sending' WHERE key=?").run(row.key)
        try {
          const result = await this.slack.post({
            channel: thread.channel,
            thread_ts: thread.thread,
            text: escaped(row.text),
          })
          this.db.query("UPDATE outbox SET phase='sent',slack_ts=? WHERE key=?").run(result.ts, row.key)
        } catch {
          this.db
            .query(
              "UPDATE outbox SET phase='indeterminate',detail='Delivery not confirmed; inspect Slack before manual action' WHERE key=?",
            )
            .run(row.key)
        }
      }
    } finally {
      this.busy = false
    }
  }
}
