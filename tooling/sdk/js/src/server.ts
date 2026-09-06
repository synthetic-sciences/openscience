import type { Config } from "./gen/types.gen.js"
import { startServer, type ServerProcessOptions } from "./server-process.js"

export type ServerOptions = ServerProcessOptions & { config?: Config }

export function createOpenScienceServer(options?: ServerOptions) {
  return startServer(options)
}
