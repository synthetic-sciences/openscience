import { afterEach, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { App, type Config } from "./app"
import {
  HTTPFailure,
  RuntimeHTTP,
  SlackHTTP,
  type Decision,
  type Receipt,
  type Run,
  type Runtime,
  type Slack,
  type Snapshot,
} from "./runtime"

const now = 1_800_000_000_000
const roots: string[] = []
const apps: App[] = []
afterEach(() => {
  for (const app of apps.splice(0)) {
    try {
      app.close()
    } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

class FixtureRuntime implements Runtime {
  created: string[] = []
  prompts: { project: string; sessionID: string; requestID: string; message: string }[] = []
  started = 0
  runs: Run[] = []
  receipts = new Map<string, Receipt>()
  permissions: Snapshot["permissions"] = []
  questions: Snapshot["questions"] = []
  decisions: Decision[] = []
  decisionAttempts = 0
  lostDecision = false
  cancelled: string[] = []
  lostReceipt = false
  lostSession = false
  expired = false
  async create(project: string) {
    this.created.push(project)
    if (this.lostSession) throw new Error("Creation response lost")
    return { id: `ses_${this.created.length}` }
  }
  async prompt(project: string, input: { sessionID: string; requestID: string; message: string }) {
    this.prompts.push({ project, ...input })
    const prior = this.receipts.get(input.requestID)
    if (prior) return prior
    const receipt = { runID: `run_${++this.started}`, acceptedAt: now }
    this.receipts.set(input.requestID, receipt)
    this.runs.push({ runID: receipt.runID, sessionID: input.sessionID, state: "running" })
    if (this.lostReceipt) {
      this.lostReceipt = false
      throw new Error("Receipt lost")
    }
    return receipt
  }
  async snapshot(_project: string, sessionID: string): Promise<Snapshot> {
    return {
      runs: this.runs.filter((run) => run.sessionID === sessionID),
      latestSequence: this.expired ? 100 : 1,
      permissions: this.permissions,
      questions: this.questions,
    }
  }
  async replay(_project: string, _sessionID: string, cursor: number) {
    if (this.expired) throw new HTTPFailure(409, "cursor_expired")
    return {
      events: cursor === 0 ? [{ sequence: 1, runID: "run_1", type: "runtime.accepted" }] : [],
      latestSequence: 1,
    }
  }
  async cancel(_project: string, _sessionID: string, runID: string) {
    this.cancelled.push(runID)
    return this.runs.find((run) => run.runID === runID)!
  }
  async decide(_project: string, input: Decision) {
    this.decisionAttempts++
    if (this.decisions.some((prior) => JSON.stringify(prior) === JSON.stringify(input))) return { status: "resolved" }
    this.decisions.push(input)
    this.permissions = this.permissions.filter((item) => item.id !== input.requestID)
    this.questions = this.questions.filter((item) => item.id !== input.requestID)
    if (this.lostDecision) {
      this.lostDecision = false
      throw new Error("Decision receipt lost after resolution")
    }
    return { status: "resolved" }
  }
}
class FixtureSlack implements Slack {
  posts: { channel: string; thread_ts: string; text: string }[] = []
  ambiguous = false
  async post(input: { channel: string; thread_ts: string; text: string }) {
    this.posts.push(input)
    if (this.ambiguous) throw new Error("Response lost after Slack accepted message")
    return { ts: `${this.posts.length}.0` }
  }
}
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "openscience-slack-test-"))
  roots.push(root)
  const config: Config = {
    appID: "A1",
    botID: "U9",
    signingSecret: "offline-signing-secret",
    resultBaseURL: "https://private-runtime.example",
    bindings: [
      { team: "T1", channel: "C1", user: "U1", project: "/approved/project" },
      { team: "T1", channel: "C1", user: "U2", project: "/other/project" },
    ],
  }
  const runtime = new FixtureRuntime()
  const slack = new FixtureSlack()
  const database = path.join(root, "state.sqlite")
  const app = new App(config, database, runtime, slack, () => now)
  apps.push(app)
  return { app, config, runtime, slack, database }
}
function envelope(text = "research test objective", id = "Ev1", event: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: id,
    event: { type: "app_mention", user: "U1", channel: "C1", ts: "100.000001", text: `<@U9> ${text}`, ...event },
  }
}
function request(payload: unknown, config: Config, timestamp = String(now / 1000), mutate = false) {
  const body = JSON.stringify(payload)
  const signature = "v0=" + createHmac("sha256", config.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")
  return new Request("http://localhost/slack/events", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
      "Content-Type": "application/json",
    },
    body: body + (mutate ? " " : ""),
  })
}

// All deliveries below use FixtureSlack; this suite cannot contact Slack.
test("signature checks raw bytes and recency before challenge or event handling", async () => {
  const { app, config, runtime } = fixture()
  expect((await app.handle(request({ type: "url_verification", challenge: "test" }, config))).status).toBe(200)
  expect((await app.handle(request(envelope(), config, String(now / 1000 - 301)))).status).toBe(401)
  expect((await app.handle(request(envelope(), config, undefined, true))).status).toBe(401)
  expect((await app.handle(new Request("http://localhost/slack/events", { method: "POST", body: "{}" }))).status).toBe(
    401,
  )
  expect(runtime.created).toHaveLength(0)
})

test("allowlist, app identity, bot filtering and thread principal are enforced", async () => {
  const { app, config } = fixture()
  expect((await app.handle(request({ ...envelope(), team_id: "T2" }, config))).status).toBe(403)
  expect((await app.handle(request({ ...envelope(), api_app_id: "A2" }, config))).status).toBe(403)
  expect((await app.handle(request({ ...envelope(), is_ext_shared_channel: true }, config))).status).toBe(403)
  expect((await app.handle(request(envelope("research hi", "EvBot", { bot_id: "B1" }), config))).status).toBe(200)
  expect(app.db.query("SELECT * FROM inbox").all()).toHaveLength(0)
  expect((await app.handle(request(envelope(), config))).status).toBe(200)
  expect(
    (
      await app.handle(
        request(envelope("permission per_1 once", "Ev2", { user: "U2", thread_ts: "100.000001" }), config),
      )
    ).status,
  ).toBe(403)
})

test("acknowledgement persists before work; inbox and outbox dedupe survive restart", async () => {
  const { app, config, database, runtime, slack } = fixture()
  expect((await app.handle(request(envelope("research /untrusted/project"), config))).status).toBe(200)
  expect(runtime.created).toHaveLength(0)
  expect((await app.handle(request(envelope("research changed"), config))).status).toBe(409)
  await app.tick()
  expect(runtime.created).toEqual(["/approved/project"])
  expect(runtime.prompts[0]).toMatchObject({
    project: "/approved/project",
    requestID: "Ev1",
    message: "/untrusted/project",
  })
  expect(slack.posts).toHaveLength(1)
  app.close()
  apps.splice(apps.indexOf(app), 1)
  const resumed = new App(config, database, runtime, slack, () => now)
  apps.push(resumed)
  expect((await resumed.handle(request(envelope("research /untrusted/project"), config))).status).toBe(200)
  await resumed.tick()
  expect(runtime.started).toBe(1)
  expect(slack.posts).toHaveLength(1)
})

test("lost prompt receipt reconciles the same request without reexecuting an interrupted run", async () => {
  const { app, config, runtime, slack } = fixture()
  runtime.lostReceipt = true
  await app.handle(request(envelope(), config))
  await app.tick()
  runtime.runs[0].state = "interrupted"
  await app.tick()
  await app.tick()
  expect(runtime.prompts.map((input) => input.requestID)).toEqual(["Ev1", "Ev1"])
  expect(runtime.started).toBe(1)
  expect(slack.posts.some((post) => post.text.includes("will not be restarted automatically"))).toBe(true)
})

test("uncertain session creation and Slack delivery never retry automatically", async () => {
  const { app, config, runtime, slack } = fixture()
  runtime.lostSession = true
  await app.handle(request(envelope(), config))
  await app.tick()
  await app.handle(request(envelope("research again", "Ev2"), config))
  await app.tick()
  expect(runtime.created).toHaveLength(1)
  expect(runtime.started).toBe(0)
  expect(app.db.query<{ phase: string }, []>("SELECT phase FROM threads").get()?.phase).toBe("indeterminate")
  slack.ambiguous = true
  await app.handle(request(envelope("research another", "Ev3"), config))
  await app.tick()
  const count = slack.posts.length
  await app.tick()
  expect(slack.posts).toHaveLength(count)
  expect(app.db.query("SELECT * FROM outbox WHERE phase='indeterminate'").all()).not.toHaveLength(0)
})

test("snapshot recovers expired cursors and stores authenticated result links once", async () => {
  const { app, config, runtime, slack } = fixture()
  await app.handle(request(envelope(), config))
  await app.tick()
  runtime.expired = true
  runtime.runs[0] = { ...runtime.runs[0], state: "completed", resultMessageID: "msg_result" }
  await app.tick()
  await app.tick()
  const result = app.db.query<{ result_url: string }, []>("SELECT result_url FROM runs").get()
  expect(result?.result_url).toContain("https://private-runtime.example/session/ses_1/message/msg_result")
  expect(result?.result_url).not.toContain("token")
  expect(app.db.query<{ cursor: number }, []>("SELECT cursor FROM threads").get()?.cursor).toBe(100)
  expect(slack.posts.filter((post) => post.text.includes("run_1: completed"))).toHaveLength(1)
})

test("permissions and questions require same-principal fresh pending mappings; persistent grants are denied", async () => {
  const { app, config, runtime } = fixture()
  await app.handle(request(envelope(), config))
  await app.tick()
  runtime.permissions = [{ id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["echo test"] }]
  runtime.questions = [{ id: "que_1", sessionID: "ses_1", questions: [{ question: "Choose" }] }]
  await app.tick()
  await app.handle(request(envelope("permission per_1 always", "EvAlways"), config))
  await app.tick()
  expect(runtime.decisions).toHaveLength(0)
  await app.handle(request(envelope('answer que_1 [["keep  two spaces"]]', "EvAnswer"), config))
  await app.tick()
  expect(runtime.decisions[0].answers).toEqual([["keep  two spaces"]])
  await app.handle(request(envelope("permission per_1 once", "EvOnce"), config))
  await app.tick()
  expect(runtime.decisions[1]).toEqual({ sessionID: "ses_1", requestID: "per_1", kind: "permission", reply: "once" })
  await app.handle(request(envelope("permission per_1 once", "EvExpired"), config))
  await app.tick()
  expect(runtime.decisions).toHaveLength(2)
})

test("cancel only targets a run recorded in the same Slack thread", async () => {
  const { app, config, runtime } = fixture()
  await app.handle(request(envelope(), config))
  await app.tick()
  await app.handle(request(envelope("cancel run_foreign", "EvWrong"), config))
  await app.tick()
  expect(runtime.cancelled).toHaveLength(0)
  await app.handle(request(envelope("cancel run_1", "EvCancel"), config))
  await app.tick()
  expect(runtime.cancelled).toEqual(["run_1"])
})

test("public HTTP transports scope paths, block redirects, and use injectable Slack calls", async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const runtime = new RuntimeHTTP("https://runtime.example", "fixture-token", async (url, init) => {
    calls.push({ url: String(url), init })
    return Response.json({ runID: "run_1", acceptedAt: now })
  })
  await runtime.prompt("/fixed/project", { sessionID: "ses_1", requestID: "Ev1", message: "hi", effort: "normal" })
  expect(new URL(calls[0].url).pathname).toBe("/runtime/prompt")
  expect(new URL(calls[0].url).searchParams.get("directory")).toBe("/fixed/project")
  expect(calls[0].init?.redirect).toBe("error")
  const slack = new SlackHTTP("offline-token", async (url, init) => {
    calls.push({ url: String(url), init })
    return Response.json({ ok: true, ts: "1.0" })
  })
  await slack.post({ channel: "C1", thread_ts: "1.0", text: "test" })
  expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({ mrkdwn: false, parse: "none", unfurl_links: false })
})

test("a lost decision receipt recovers the identical operation after the request stops being pending", async () => {
  const { app, config, runtime } = fixture()
  await app.handle(request(envelope(), config))
  await app.tick()
  runtime.permissions = [{ id: "per_lost", sessionID: "ses_1", permission: "read", patterns: ["notes.txt"] }]
  await app.tick()
  runtime.lostDecision = true
  await app.handle(request(envelope("permission per_lost once", "EvDecisionLost"), config))
  await app.tick()
  expect(runtime.permissions).toHaveLength(0)
  await app.tick()
  expect(runtime.decisionAttempts).toBe(2)
  expect(runtime.decisions).toHaveLength(1)
  expect(app.db.query<{ phase: string }, []>("SELECT phase FROM inbox WHERE id='EvDecisionLost'").get()?.phase).toBe(
    "processed",
  )
})

test("a process stopping during outbound delivery is indeterminate after restart", async () => {
  const { app, config, runtime, slack, database } = fixture()
  await app.handle(request(envelope(), config))
  await app.tick()
  app.db.query("UPDATE outbox SET phase='sending',slack_ts=NULL WHERE key='accepted:run_1'").run()
  app.close()
  apps.splice(apps.indexOf(app), 1)
  const resumed = new App(config, database, runtime, slack, () => now)
  apps.push(resumed)
  await resumed.tick()
  expect(slack.posts).toHaveLength(1)
  expect(
    resumed.db.query<{ phase: string }, []>("SELECT phase FROM outbox WHERE key='accepted:run_1'").get()?.phase,
  ).toBe("indeterminate")
})

test("revoked bindings cannot resume work or send messages and bot tokens cannot span workspaces", async () => {
  const { app, config, runtime, slack, database } = fixture()
  await app.handle(request(envelope(), config))
  config.bindings = config.bindings.filter((binding) => binding.user !== "U1")
  await app.tick()
  expect(runtime.created).toHaveLength(0)
  expect(slack.posts).toHaveLength(0)
  expect(
    () =>
      new App(
        { ...config, bindings: [...config.bindings, { team: "T2", channel: "C2", user: "U3", project: "/third" }] },
        database,
        runtime,
        slack,
      ),
  ).toThrow("one installed Slack workspace")
})

test("revoked inbox rows cannot starve another principal or resume after reallow", async () => {
  const { app, config, runtime } = fixture()
  const bindings = config.bindings.slice()
  for (let index = 0; index < 21; index++) {
    await app.handle(request(envelope(`research removed principal task ${index}`, `EvRevoked${index}`), config))
  }
  config.bindings = bindings.filter((binding) => binding.user !== "U1")
  await app.handle(request(envelope("research authorized work", "EvActive", { user: "U2", ts: "200.000001" }), config))
  await app.tick()
  await app.tick()
  expect(runtime.prompts).toHaveLength(1)
  expect(runtime.prompts[0]).toMatchObject({ project: "/other/project", message: "authorized work" })
  expect(app.db.query("SELECT * FROM inbox WHERE phase='revoked'").all()).toHaveLength(21)
  config.bindings = bindings
  await app.tick()
  expect(runtime.started).toBe(1)
})

test("revoked outbox rows cannot starve another principal or send after reallow", async () => {
  const { app, config, runtime, slack } = fixture()
  const bindings = config.bindings.slice()
  await app.handle(request(envelope(), config))
  await app.tick()
  for (let index = 0; index < 22; index++) {
    await app.handle(request(envelope("status", `EvStatus${index}`), config))
  }
  await app.tick()
  await app.tick()
  expect(app.db.query("SELECT * FROM outbox WHERE phase='pending'").all()).toHaveLength(20)
  const sent = slack.posts.length
  config.bindings = bindings.filter((binding) => binding.user !== "U1")
  await app.handle(request(envelope("research authorized work", "EvActive", { user: "U2", ts: "200.000001" }), config))
  await app.tick()
  await app.tick()
  expect(runtime.started).toBe(2)
  expect(slack.posts.slice(sent)).toEqual([
    { channel: "C1", thread_ts: "200.000001", text: "Research accepted: run_2" },
  ])
  expect(app.db.query("SELECT * FROM outbox WHERE phase='revoked'").all()).toHaveLength(20)
  config.bindings = bindings
  await app.tick()
  expect(slack.posts).toHaveLength(sent + 1)
})

test("runtime bearer credentials never follow an HTTP redirect to another origin", async () => {
  const forwarded: string[] = []
  using destination = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      forwarded.push(request.headers.get("Authorization") ?? "")
      return Response.json({ protocolVersion: "1.0" })
    },
  })
  const received: string[] = []
  using origin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      received.push(request.headers.get("Authorization") ?? "")
      return new Response(null, { status: 307, headers: { Location: `${destination.url.origin}/stolen` } })
    },
  })
  const runtime = new RuntimeHTTP(origin.url.origin, "offline-runtime-token")
  await expect(runtime.capabilities("/fixed/project")).rejects.toThrow()
  expect(received).toEqual(["Bearer offline-runtime-token"])
  expect(forwarded).toEqual([])
  for (const url of [
    "https://name:secret@runtime.example",
    "https://runtime.example?token=secret",
    "https://runtime.example#secret",
    "file:///tmp/server",
  ]) {
    expect(() => new RuntimeHTTP(url, "offline-runtime-token")).toThrow("Runtime URL")
  }
})
