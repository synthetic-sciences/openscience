import { fileURLToPath } from "node:url"
import { createServer, type InlineConfig } from "vite"

/** Component tests load browser modules through SSR, not a served application.
 * Loading the app config also starts RDKit/dependency optimization in every test
 * server; those unnecessary scans can race each other and outlive teardown. */
export function createTestServer(config: InlineConfig) {
  const aliases = config.resolve?.alias
  return createServer({
    ...config,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: {
      ...config.resolve,
      alias: [
        ...(Array.isArray(aliases)
          ? aliases
          : Object.entries(aliases ?? {}).map(([find, replacement]) => ({ find, replacement }))),
        { find: "@", replacement: fileURLToPath(new URL("../src", import.meta.url)) },
      ],
    },
  })
}
