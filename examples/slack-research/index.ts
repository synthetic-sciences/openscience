import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { App, type Binding } from "./app"
import { RuntimeHTTP, SlackHTTP } from "./runtime"

function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

if (import.meta.main) {
  const database = path.resolve(required("SLACK_STATE_PATH"))
  mkdirSync(path.dirname(database), { recursive: true, mode: 0o700 })
  // Do not automatically steal a stale lock: first inspect the owning process
  // and any in-flight Slack delivery, then remove the exact lock explicitly.
  const lock = openSync(database + ".lock", "wx", 0o600)
  writeFileSync(lock, String(process.pid))
  let unlocked = false
  function unlock() {
    if (unlocked) return
    unlocked = true
    closeSync(lock)
    unlinkSync(database + ".lock")
  }
  process.once("exit", unlock)
  const runtime = new RuntimeHTTP(required("OPENSCIENCE_URL"), process.env.OPENSCIENCE_AUTH_TOKEN)
  const bindings = (await Bun.file(required("SLACK_BINDINGS_PATH")).json()) as Binding[]
  const app = new App(
    {
      appID: required("SLACK_APP_ID"),
      botID: required("SLACK_BOT_USER_ID"),
      signingSecret: required("SLACK_SIGNING_SECRET"),
      bindings,
      resultBaseURL: process.env.OPENSCIENCE_RESULT_URL ?? required("OPENSCIENCE_URL"),
    },
    database,
    runtime,
    new SlackHTTP(required("SLACK_BOT_TOKEN")),
  )
  for (const binding of bindings) {
    const capabilities = await runtime.capabilities(binding.project)
    if (capabilities.protocolVersion !== "1.0") throw new Error("Runtime protocol 1.0 is required")
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env.PORT ?? 3100),
    maxRequestBodySize: 65_536,
    fetch: (request) => app.handle(request),
  })
  let pending: Promise<void> | undefined
  const timer = setInterval(() => {
    if (pending) return
    pending = app
      .tick()
      .catch(() => console.error("Slack worker failed; inspect the local database"))
      .finally(() => {
        pending = undefined
      })
  }, 2000)
  console.log(`Private Slack research adapter listening at ${server.url.origin}/slack/events`)
  let stopping = false
  async function stop() {
    if (stopping) return
    stopping = true
    clearInterval(timer)
    server.stop(true)
    await pending
    app.close()
    unlock()
    process.exit(0)
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}
