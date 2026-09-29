import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const file = (name: string) => path.join(Global.Path.config, name)
const write = (name: string, body: unknown) =>
  Bun.write(file(name), typeof body === "string" ? body : JSON.stringify(body))

// Config.global is a lazy singleton shared by every test file in the worker,
// so an earlier file may already have resolved it against an empty config
// directory. config.test.ts's global-writes block resets it for the same
// reason; without a reset the reads below can observe that stale cache
// instead of the files just written.
async function clean() {
  for (const name of ["openscience.jsonc", "openscience.json", "config.json"]) {
    await fs.rm(file(name), { force: true })
  }
  Config.global.reset()
}

beforeEach(clean)
afterEach(clean)

async function reload() {
  Config.global.reset()
  return Config.global()
}

test("openscience.json overrides openscience.jsonc in the global config", async () => {
  // CONFIG_FILES documents the order as "oldest first: later merges win, so
  // the legacy names load as the base and openscience.json(c) overrides them",
  // and the project-config path follows that list. The global loader listed
  // these two the other way round.
  await write("openscience.jsonc", '{ "model": "model-from-the-jsonc-file" }')
  await write("openscience.json", '{ "model": "model-from-the-json-file" }')
  expect((await reload()).model).toBe("model-from-the-json-file")
})

test("every global writer's save survives a reload when both files exist", async () => {
  await using tmp = await tmpdir()
  const provider = (baseURL: string) => ({ provider: { local: { name: "Local", options: { baseURL } } } })
  await write("openscience.jsonc", { model: "stale/jsonc", ...provider("http://jsonc/v1") })
  await write("openscience.json", { model: "stale/json", ...provider("http://json/v1") })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Config.updateGlobal({ model: "saved/update" })
      expect((await reload()).model).toBe("saved/update")

      await Config.setProvider("local", { name: "Local", options: { baseURL: "http://saved/v1" } })
      expect((await reload()).provider?.local?.options?.baseURL).toBe("http://saved/v1")

      await Config.replaceGlobal(JSON.stringify({ model: "saved/raw" }))
      expect((await reload()).model).toBe("saved/raw")
    },
  })
})

test("a global save still goes to openscience.jsonc when it is the only file", async () => {
  await using tmp = await tmpdir()
  await write("openscience.jsonc", '{\n  // keep me\n  "model": "old/model"\n}\n')
  await Instance.provide({
    directory: tmp.path,
    fn: () => Config.updateGlobal({ model: "saved/model" }),
  })
  expect(await Bun.file(file("openscience.json")).exists()).toBe(false)
  expect(await Bun.file(file("openscience.jsonc")).text()).toContain("// keep me")
  expect((await reload()).model).toBe("saved/model")
})

test("a first global save creates openscience.jsonc", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: () => Config.updateGlobal({ model: "saved/model" }),
  })
  expect(await Bun.file(file("openscience.json")).exists()).toBe(false)
  expect(await Bun.file(file("openscience.jsonc")).json()).toMatchObject({ model: "saved/model" })
})
