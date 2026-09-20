import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { GracefulShutdown } from "../../process/graceful-shutdown"
import { ShutdownSignal } from "../../process/shutdown-signal"
import { DesktopParent } from "../../process/desktop-parent"
import { Installation } from "../../installation"
import { Global } from "../../global"
import { ServerIdentity } from "../../server/identity"
import { advertiseDesktopServer, withdrawDesktopServer } from "../local-server"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("format", {
      choices: ["text", "json"] as const,
      describe: "server readiness output format",
    }),
  describe: "starts a headless openscience server",
  handler: async (args) => {
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)
    using parent = DesktopParent.watch()
    // Only the app's own sidecar advertises itself. A terminal `openscience
    // serve` is a deliberate second server, not the one a plain `openscience`
    // should attach to. The run id is what this server answers `/global/health`
    // with, so a reader can tell our listener from anything else that took the
    // port. The shutdown below withdraws the record, and an `exit` handler is
    // the safety net for the paths that never reach it (a crash, a second
    // signal, the watchdog); a record outliving its process is only ever
    // ignored.
    const advertisedPort = parent ? server.port : undefined
    if (advertisedPort) {
      process.once("exit", () => withdrawDesktopServer(Global.Path.data, process.pid))
      await advertiseDesktopServer(Global.Path.data, {
        port: advertisedPort,
        pid: process.pid,
        version: Installation.VERSION,
        runId: ServerIdentity.current.runId,
      })
    }
    const signal = Promise.withResolvers<void>()
    // One owner for this process's termination signals. The kernel hooks that
    // otherwise exit on SIGTERM defer while this claim stands, so the shutdown
    // body below is what ends the process.
    const release = ShutdownSignal.claim(() => signal.resolve())
    const format = args.format ?? process.env.OPENSCIENCE_SERVER_READY_FORMAT ?? "text"
    console.log(
      format === "json"
        ? JSON.stringify({
            type: "server.ready",
            schemaVersion: 1,
            url: server.url.origin,
            pid: process.pid,
            version: Installation.VERSION,
          })
        : `openscience server listening on http://localhost:${server.port}`,
    )
    try {
      await Promise.race([signal.promise, parent?.exited ?? new Promise<never>(() => undefined)])
    } finally {
      release()
    }
    // Stop advertising before draining: a terminal launch that arrives during
    // the drain must start its own server, not attach to one that is leaving.
    if (advertisedPort) withdrawDesktopServer(Global.Path.data, process.pid)
    const watchdog = setTimeout(() => process.exit(1), 10_000)
    watchdog.unref?.()
    try {
      await server.stop(true)
      await GracefulShutdown.run({ timeoutMs: 8_000 })
    } finally {
      clearTimeout(watchdog)
    }
  },
})
