export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { OpenScienceClient } from "./gen/sdk.gen.js"
export { type Config as OpenScienceClientConfig, OpenScienceClient }

export function createOpenScienceClient(
  config?: Config & { directory?: string; projectID?: string; project?: string },
) {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    const isNonASCII = /[^\x00-\x7F]/.test(config.directory)
    const encodedDirectory = isNonASCII ? encodeURIComponent(config.directory) : config.directory
    config.headers = {
      ...config.headers,
      "x-openscience-directory": encodedDirectory,
    }
  }

  const project = config?.projectID ?? config?.project
  if (project) {
    config.headers = {
      ...config.headers,
      "x-openscience-project": project,
    }
  }

  const client = createClient(config)
  return new OpenScienceClient({ client })
}
