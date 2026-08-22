import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Ripgrep } from "../../src/file/ripgrep"
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

test.skipIf(process.platform === "win32")(
  "file discovery and search do not follow directory symlinks by default",
  async () => {
    await using external = await tmpdir({
      init: (directory) => Bun.write(path.join(directory, "secret.txt"), "outside secret\n"),
    })
    await using project = await tmpdir({
      git: true,
      init: async (directory) => {
        await Bun.write(path.join(directory, "inside.txt"), "inside value\n")
        await fs.symlink(external.path, path.join(directory, "escape"), "dir")
      },
    })

    const files = await Array.fromAsync(Ripgrep.files({ cwd: project.path }))
    const matches = await Ripgrep.search({ cwd: project.path, pattern: "outside secret" })
    expect(files).toContain("inside.txt")
    expect(files.some((file) => file.includes("secret.txt"))).toBeFalse()
    expect(matches).toEqual([])

    const followed = await Array.fromAsync(Ripgrep.files({ cwd: project.path, follow: true }))
    expect(followed.some((file) => file.includes("secret.txt"))).toBeTrue()
  },
)

test("stopping file discovery early terminates and reaps ripgrep", async () => {
  await using project = await tmpdir({
    init: async (directory) => {
      await Promise.all(
        Array.from({ length: 1_000 }, (_, index) => Bun.write(path.join(directory, `file-${index}.txt`), "value\n")),
      )
    },
  })

  const iterator = Ripgrep.files({ cwd: project.path })
  expect((await iterator.next()).done).toBeFalse()
  const result = await Promise.race([iterator.return(undefined), Bun.sleep(2_000).then(() => "timeout" as const)])
  expect(result).not.toBe("timeout")
})
