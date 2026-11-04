import { expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { InstructionPrompt } from "../../src/session/instruction"
import { Network } from "../../src/settings/network"
import { tmpdir } from "../fixture/fixture"

const url = "https://example.com/memory-budget-policy"

// Match the existing instruction tests' controlled transport; real source
// selection, reads, network policy and byte accounting still execute.
async function remote(fn: () => Promise<unknown>, content = "REMOTE_POLICY") {
  const previous = globalThis.fetch
  await Network.set({ allowlistEnabled: true, enabled: [], custom: ["example.com"] })
  globalThis.fetch = Object.assign(async () => new Response(content), { preconnect: previous.preconnect })
  try {
    await fn()
  } finally {
    globalThis.fetch = previous
    await Network.set({ allowlistEnabled: false, enabled: ["package-management"], custom: [] })
  }
}

test("remote policy keeps its source slot before 64 notes and recalled conversations", async () => {
  await using tmp = await tmpdir({
    config: { instructions: [url] },
    init: async (dir) => {
      for (const index of Array.from({ length: 64 }, (_, n) => n)) {
        await Bun.write(path.join(dir, ".openscience", "memory", `${index}.md`), "NOTE")
      }
    },
  })
  await remote(() =>
    Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const entries = await InstructionPrompt.system(["AUTOMATIC_MEMORY"])
        expect(entries).toHaveLength(64)
        expect(entries[0]).toBe(`Instructions from: ${url}\nREMOTE_POLICY`)
        expect(entries).not.toContain("AUTOMATIC_MEMORY")
      },
    }),
  )
})

test("remote policy consumes byte budget before large notes", async () => {
  await using tmp = await tmpdir({
    config: { instructions: [url] },
    init: async (dir) => {
      for (const n of [0, 1, 2, 3])
        await Bun.write(path.join(dir, ".openscience", "memory", `${n}.md`), "m".repeat(260_000))
    },
  })
  await remote(
    () =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const entries = await InstructionPrompt.system()
          expect(entries[0]).toBe(`Instructions from: ${url}\n${"r".repeat(20_000)}`)
          expect(entries.filter((entry) => entry.startsWith("Project memory from: "))).toHaveLength(3)
          expect(entries.reduce((sum, entry) => sum + Buffer.byteLength(entry), 0)).toBeLessThanOrEqual(1024 * 1024)
        },
      }),
    "r".repeat(20_000),
  )
})

test("exactly full instruction budget cannot grow through notes or recall", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const files = [0, 1, 2, 3].map((n) => path.join(dir, `rule-${n}.md`))
      const headers = files.reduce((sum, file) => sum + Buffer.byteLength(`Instructions from: ${file}\n`), 0)
      for (const [index, file] of files.entries()) {
        await Bun.write(file, "x".repeat(index < 3 ? 256 * 1024 : 256 * 1024 - headers))
      }
      await Bun.write(path.join(dir, "openscience.json"), JSON.stringify({ instructions: files }))
      await Bun.write(path.join(dir, ".openscience", "memory", "decision.md"), "NOTE")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const entries = await InstructionPrompt.system(["AUTOMATIC_MEMORY"])
      expect(entries).toHaveLength(4)
      expect(entries.reduce((sum, entry) => sum + Buffer.byteLength(entry), 0)).toBe(1024 * 1024)
    },
  })
})
