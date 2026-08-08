import { expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { Provider } from "../../src/provider/provider"
import { tmpdir } from "../fixture/fixture"

await import("../fixture/provider-module.mjs")

async function setup(dir: string) {
  const marker = path.join(dir, "provider-module-ran")
  const sdk = path.join(import.meta.dir, "../fixture/provider-module.mjs")
  await Bun.write(
    path.join(dir, "openscience.json"),
    JSON.stringify({
      provider: {
        probe: {
          name: "Project provider probe",
          npm: pathToFileURL(sdk).href,
          env: [],
          models: {
            m: {
              name: "Probe",
              limit: {
                context: 1000,
                output: 100,
              },
            },
          },
        },
      },
    }),
  )
  return marker
}

test("untrusted project provider remains readable without importing its file module", async () => {
  await using tmp = await tmpdir({ init: setup })
  process.env.OPENSCIENCE_TEST_PROVIDER_MODULE_MARKER = tmp.extra
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ProjectTrust.update(Instance.project, { trusted: false })
        const model = await Provider.getModel("probe", "m")
        expect(model.api.npm.startsWith("file://")).toBe(true)
        expect(model.api.npm.endsWith("/test/fixture/provider-module.mjs")).toBe(true)
        await expect(Provider.getLanguage(model)).rejects.toBeInstanceOf(Provider.InitError)
        expect(await Bun.file(tmp.extra).exists()).toBe(false)
      },
    })
  } finally {
    delete process.env.OPENSCIENCE_TEST_PROVIDER_MODULE_MARKER
  }
})

test("trusted project provider may import its declared file module", async () => {
  await using tmp = await tmpdir({ init: setup })
  process.env.OPENSCIENCE_TEST_PROVIDER_MODULE_MARKER = tmp.extra
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const status = await ProjectTrust.status(Instance.project)
        await ProjectTrust.update(Instance.project, {
          trusted: true,
          root: status.root,
        })
        const model = await Provider.getModel("probe", "m")
        await expect(Provider.getLanguage(model)).resolves.toBeDefined()
        expect(await Bun.file(tmp.extra).text()).toBe("created")
      },
    })
  } finally {
    delete process.env.OPENSCIENCE_TEST_PROVIDER_MODULE_MARKER
  }
})
