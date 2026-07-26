import { describe, expect, test } from "bun:test"
import path from "path"
import { File } from "../../src/file"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("File.search", () => {
  test("returns the initial index and refreshes it after a file is added", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "atlas.ts"), "export const atlas = true\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        try {
          expect(await File.search({ query: "atlas", dirs: false })).toEqual(["atlas.ts"])

          await File.write("fresh-result.ts", "export const fresh = true\n")

          // The first read stays responsive with the prior snapshot while it
          // starts one invalidation-driven refresh in the background.
          expect(await File.search({ query: "fresh", dirs: false })).toEqual([])

          for (let attempt = 0; attempt < 20; attempt++) {
            const result = await File.search({ query: "fresh", dirs: false })
            if (result.includes("fresh-result.ts")) return
            await Bun.sleep(5)
          }

          throw new Error("file-search index did not refresh after an add event")
        } finally {
          await Instance.dispose()
        }
      },
    })
  })
})
