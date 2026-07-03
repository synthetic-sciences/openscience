export * from "./client.js"
export * from "./server.js"

import { createOpenScienceClient } from "./client.js"
import { createOpenScienceServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createOpenScience(options?: ServerOptions) {
  const server = await createOpenScienceServer({
    ...options,
  })

  const client = createOpenScienceClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
