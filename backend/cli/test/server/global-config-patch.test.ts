import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

// Another test may leave an openscience.jsonc behind, which the writer would
// pick over the .json file this test seeds.
async function cleanGlobalConfig() {
  for (const name of ["openscience.jsonc", "openscience.json", "config.json"]) {
    await fs.rm(path.join(Global.Path.config, name), { force: true }).catch(() => {})
  }
  Config.global.reset()
}

beforeEach(cleanGlobalConfig)
afterEach(cleanGlobalConfig)

test("PATCH /global/config writes the request as sent, not the schema's expanded form", async () => {
  await using tmp = await tmpdir()
  const file = path.join(Global.Path.config, "openscience.json")
  await fs.writeFile(file, "{}")
  Config.global.reset()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const fetch = Server.internalFetch()
      const response = await fetch("http://openscience.internal/global/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5", permission: "allow" }),
      })
      expect(response.status).toBe(200)
      const raw = JSON.parse(await fs.readFile(file, "utf8"))
      // The schema reads "allow" as {"*": "allow"} and would have filled every
      // keybind default; the file keeps the two keys the user sent.
      expect(raw).toEqual({ model: "openai/gpt-5", permission: "allow" })
    },
  })
})
