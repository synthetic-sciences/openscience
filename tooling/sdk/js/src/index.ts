export * from "./client.js"
export * from "./server.js"
export * from "./v2/runtime.js"

import { createOpenScienceClient } from "./client.js"
import { createOpenScienceServer } from "./server.js"
import type { ServerOptions } from "./server.js"
import { serverClientOptions } from "./server-process.js"

export async function createOpenScience(options?: ServerOptions) {
  const connection = serverClientOptions(options)
  const server = await createOpenScienceServer({
    ...options,
  })

  const client = createOpenScienceClient({
    ...connection,
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
