import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless openscience server",
  handler: async (args) => {
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)
    console.log(`openscience server listening on http://localhost:${server.port}`)
    await new Promise(() => {})
    await server.stop()
  },
})
