import { expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { FileRoutes } from "../../src/server/routes/file"
import { tmpdir } from "../fixture/fixture"

test("file text search treats an untrusted pattern as data, never a shell command", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (directory) => {
      await Bun.write(path.join(directory, "notes.txt"), "literal ; punctuation\nordinary needle\n")
      return path.join(directory, "search-injected")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const pattern = `needle\nprintf injected > ${JSON.stringify(tmp.extra)}`
      const response = await FileRoutes().request(`/find?pattern=${encodeURIComponent(pattern)}`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([])
      expect(await Bun.file(tmp.extra).exists()).toBe(false)

      const literal = await FileRoutes().request(`/find?pattern=${encodeURIComponent("literal ; punctuation")}`)
      expect(literal.status).toBe(200)
      expect((await literal.json()) as unknown[]).toHaveLength(1)
    },
  })
})
