import z from "zod"
import { Plugin } from "../../plugin"
import { Instance } from "../../project/instance"
import { ProjectTrust } from "../../project/trust"
import { Config } from "../../config/config"
import { registry } from "."
import { ConnectorRegistry, type Connector } from "./types"

const definition = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1),
  domain: z.enum([
    "biology",
    "chemistry",
    "physics",
    "genomics",
    "proteomics",
    "structure",
    "literature",
    "materials",
    "clinical",
    "general",
  ]),
  description: z.string().min(1),
  homepage: z.url().optional(),
  formats: z.array(z.string().min(1)).optional(),
})

/** Compose instance contributions without mutating the process-wide built-in catalog. */
export async function connectorRegistry() {
  const scoped = new ConnectorRegistry()
  for (const connector of registry.all()) scoped.register(connector)
  const directory = Instance.directory
  const project = Instance.project
  for (const hook of await Plugin.list()) {
    const owned = Plugin.projectOwned(hook)
    if (owned && !(await ProjectTrust.allowed(project))) continue
    for (const connector of hook.connector ?? []) {
      const parsed = definition.safeParse(connector)
      if (
        !parsed.success ||
        typeof connector.search !== "function" ||
        typeof connector.fetch !== "function" ||
        (connector.formats?.length ? typeof connector.fetchFile !== "function" : connector.fetchFile !== undefined) ||
        connector.formats?.includes("json")
      ) {
        throw new Error(`Invalid scientific connector contribution: ${connector.id ?? "(missing id)"}`)
      }
      const guard = async () => {
        if (Instance.directory !== directory) throw new Error("A plugin connector belongs to another project instance")
        if (owned) {
          await ProjectTrust.require(project, "project_plugin")
          if ((await Config.trustedSandbox()).enabled)
            throw new Error("Project plugins cannot run inside the execution sandbox")
        }
      }
      const wrapped: Connector = {
        ...parsed.data,
        async search(query, options) {
          await guard()
          return connector.search(query, options)
        },
        async fetch(id, options) {
          await guard()
          return connector.fetch(id, options)
        },
        ...(connector.fetchFile
          ? {
              async fetchFile(
                id: string,
                format: string,
                options?: Parameters<NonNullable<Connector["fetchFile"]>>[2],
              ) {
                await guard()
                return connector.fetchFile!(id, format, options)
              },
            }
          : {}),
      }
      scoped.register(wrapped)
    }
  }
  return scoped
}
