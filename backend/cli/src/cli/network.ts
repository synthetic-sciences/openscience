import type { Argv, InferredOptionTypes } from "yargs"
import { Config } from "../config/config"

const options = {
  port: {
    type: "number" as const,
    describe: "port to listen on",
    default: 0,
  },
  cors: {
    type: "string" as const,
    array: true,
    describe: "additional domains to allow for CORS",
    default: [] as string[],
  },
}

export type NetworkOptions = InferredOptionTypes<typeof options>

export function withNetworkOptions<T>(yargs: Argv<T>) {
  return yargs.options(options)
}

// The server is loopback-only by design — there is no hostname/mDNS option.
// Existing openscience.json files may still carry server.hostname/server.mdns; those
// keys are parsed by the config schema but intentionally ignored here.
export async function resolveNetworkOptions(args: NetworkOptions) {
  const config = await Config.global()
  if (config?.server?.hostname || config?.server?.mdns) {
    console.warn(
      "openscience: server.hostname / server.mdns in your config are no longer supported — the server always binds to localhost (127.0.0.1).",
    )
  }
  const portExplicitlySet = process.argv.includes("--port")
  const port = portExplicitlySet ? args.port : (config?.server?.port ?? args.port)
  const configCors = config?.server?.cors ?? []
  const argsCors = Array.isArray(args.cors) ? args.cors : args.cors ? [args.cors] : []
  const cors = [...configCors, ...argsCors]
  return { port, cors }
}
