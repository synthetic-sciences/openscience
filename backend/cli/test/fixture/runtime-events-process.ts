import { Instance } from "../../src/project/instance"
import { ProcessIdentity } from "../../src/process/process-identity"
import { RuntimeEvents } from "../../src/runtime/events"

const [mode, workspace, sessionID, runID, output, command] = process.argv.slice(2)

if (!mode || !workspace || !sessionID || !runID || !output) {
  throw new Error("Expected mode, workspace, sessionID, runID, and output")
}

async function write(value: unknown) {
  await Bun.write(output, JSON.stringify(value))
}

await Instance.provide({
  directory: workspace,
  fn: async () => {
    if (mode === "owner") {
      await RuntimeEvents.begin({ sessionID, runID, acceptedAt: Date.now(), effort: "normal" })
      const identity = await ProcessIdentity.capture(process.pid)
      if (!identity) throw new Error("Could not capture fixture owner identity")
      await write({ ready: true, pid: process.pid, identity })
      if (!command) await new Promise(() => {})
      for (;;) {
        const action = await Bun.file(command)
          .text()
          .catch(() => "")
        if (action.trim() === "cancel") {
          const result = await RuntimeEvents.cancel({ sessionID, runID, source: "user" })
          await write({ result, replay: await RuntimeEvents.replay(sessionID) })
          return
        }
        await Bun.sleep(10)
      }
    }

    if (mode === "watch-owner") {
      await RuntimeEvents.begin({ sessionID, runID, acceptedAt: Date.now(), effort: "normal" })
      const identity = await ProcessIdentity.capture(process.pid)
      if (!identity) throw new Error("Could not capture fixture owner identity")
      let handled = false
      await using watcher = RuntimeEvents.watchCancellationRequests(async (request) => {
        const result = await RuntimeEvents.cancel(request)
        await write({ ready: true, pid: process.pid, identity, result, replay: await RuntimeEvents.replay(sessionID) })
        handled = true
      }, 10)
      await write({ ready: true, pid: process.pid, identity })
      while (!handled) await Bun.sleep(10)
      return
    }

    if (mode === "cancel-and-begin") {
      const result = await RuntimeEvents.cancel({ sessionID, runID, source: "user" })
      let begin = "accepted"
      try {
        await RuntimeEvents.begin({
          sessionID,
          runID: `${runID}_contender`,
          acceptedAt: Date.now(),
          effort: "normal",
        })
      } catch (error) {
        begin = error instanceof RuntimeEvents.ActiveRunError ? "active" : `error:${String(error)}`
      }
      await write({ result, begin, replay: await RuntimeEvents.replay(sessionID) })
      return
    }

    if (mode === "request-cancel") {
      const result = await RuntimeEvents.requestCancel({ sessionID, source: "user" })
      await write({ result, replay: await RuntimeEvents.replay(sessionID) })
      return
    }

    if (mode === "begin") {
      await RuntimeEvents.begin({ sessionID, runID, acceptedAt: Date.now(), effort: "ultra" })
      await write({ replay: await RuntimeEvents.replay(sessionID) })
      return
    }

    throw new Error(`Unknown runtime-events fixture mode: ${mode}`)
  },
})
