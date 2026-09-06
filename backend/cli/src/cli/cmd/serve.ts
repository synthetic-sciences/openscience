import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { GracefulShutdown } from "../../process/graceful-shutdown"
import { DesktopParent } from "../../process/desktop-parent"
import { Installation } from "../../installation"

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
