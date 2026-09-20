import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { GracefulShutdown } from "../../process/graceful-shutdown"
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
    // port. Withdrawal runs from an `exit` handler: the kernel signal hooks in
    // this process graph exit on SIGTERM without unwinding this handler, and a
    // record outliving its process is only ever ignored.
    if (parent && server.port) {
      const port = server.port
      process.once("exit", () => withdrawDesktopServer(Global.Path.data, process.pid))
      await advertiseDesktopServer(Global.Path.data, {
        port,
        pid: process.pid,
        version: Installation.VERSION,
        runId: ServerIdentity.current.runId,
      })
    }
    const signal = Promise.withResolvers<void>()
    const stop = () => signal.resolve()
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
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
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
    }
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
