import { describe, expect, test } from "bun:test"
import path from "path"
import { InstructionPrompt } from "../../src/session/instruction"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Network } from "../../src/settings/network"

describe("InstructionPrompt.resolve", () => {
  test("returns empty when AGENTS.md is at project root (already in systemPaths)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Root Instructions")
        await Bun.write(path.join(dir, "src", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const system = await InstructionPrompt.systemPaths()
        expect(system.has(path.join(tmp.path, "AGENTS.md"))).toBe(true)

        const results = await InstructionPrompt.resolve([], path.join(tmp.path, "src", "file.ts"), "test-message-1")
        expect(results).toEqual([])
      },
    })
  })

  test("remote instructions use network policy and refuse a loopback redirect", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "openscience.json"),
          JSON.stringify({ instructions: ["https://example.com/instructions"] }),
        )
      },
    })
    const original = globalThis.fetch
    const calls: string[] = []
    await Network.set({ allowlistEnabled: true, enabled: [], custom: ["example.com"] })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:4096/secret" } })
    }) as typeof fetch
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await InstructionPrompt.system()
          expect(result.some((entry) => entry.includes("example.com/instructions"))).toBe(false)
          expect(calls).toEqual(["https://example.com/instructions"])
        },
      })
    } finally {
      globalThis.fetch = original
      await Network.set({ allowlistEnabled: false, enabled: ["package-management"], custom: [] })
    }
  })

  test("returns AGENTS.md from subdirectory (not in systemPaths)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "AGENTS.md"), "# Subdir Instructions")
        await Bun.write(path.join(dir, "subdir", "nested", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const system = await InstructionPrompt.systemPaths()
        expect(system.has(path.join(tmp.path, "subdir", "AGENTS.md"))).toBe(false)

        const results = await InstructionPrompt.resolve(
          [],
          path.join(tmp.path, "subdir", "nested", "file.ts"),
          "test-message-2",
        )
        expect(results.length).toBe(1)
        expect(results[0].filepath).toBe(path.join(tmp.path, "subdir", "AGENTS.md"))
      },
    })
  })
})
