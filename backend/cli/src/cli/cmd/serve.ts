import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { GracefulShutdown } from "../../process/graceful-shutdown"
import { DesktopParent } from "../../process/desktop-parent"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless openscience server",
  handler: async (args) => {
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)
    console.log(`openscience server listening on http://localhost:${server.port}`)
    using parent = DesktopParent.watch()
    await Promise.race([
      new Promise<void>((resolve) => {
        const stop = () => resolve()
        process.once("SIGINT", stop)
        process.once("SIGTERM", stop)
      }),
      parent?.exited ?? new Promise<never>(() => undefined),
    ])
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
