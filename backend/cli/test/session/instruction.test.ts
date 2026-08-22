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

  test("skips oversized local instruction files without buffering the whole source", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), `begin\n${"x".repeat(2 * 1024 * 1024)}\nsecret-tail\n`)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await InstructionPrompt.system()
        expect(result.some((entry) => entry.includes("secret-tail"))).toBe(false)
        expect(result.some((entry) => entry.includes(path.join(tmp.path, "AGENTS.md")))).toBe(false)
      },
    })
  })

  test("rejects a non-regular local instruction source without blocking", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir()
    const instruction = path.join(tmp.path, "AGENTS.md")
    const fifo = Bun.spawn(["mkfifo", instruction], { stdout: "ignore", stderr: "pipe" })
    const [code, error] = await Promise.all([fifo.exited, new Response(fifo.stderr).text()])
    if (code !== 0) throw new Error(error)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const started = Date.now()
        expect(await InstructionPrompt.system()).toEqual([])
        expect(Date.now() - started).toBeLessThan(1_000)
      },
    })
  })

  test("caps the combined instruction payload across many individually valid files", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const files = Array.from({ length: 6 }, (_, index) => path.join(dir, `rules-${index}.md`))
        await Promise.all(files.map((file, index) => Bun.write(file, `${index}\n${"x".repeat(220 * 1024)}`)))
        await Bun.write(path.join(dir, "openscience.json"), JSON.stringify({ instructions: files }))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await InstructionPrompt.system()
        expect(result.length).toBeLessThan(6)
        expect(result.reduce((sum, entry) => sum + Buffer.byteLength(entry), 0)).toBeLessThanOrEqual(1024 * 1024)
      },
    })
  })

  test("cancels a chunked remote instruction response at the source limit", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "openscience.json"),
          JSON.stringify({ instructions: ["https://example.com/oversized-instructions"] }),
        )
      },
    })
    const original = globalThis.fetch
    const state = { pulls: 0, cancelled: false }
    await Network.set({ allowlistEnabled: true, enabled: [], custom: ["example.com"] })
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            state.pulls++
            controller.enqueue(new Uint8Array(64 * 1024))
          },
          cancel() {
            state.cancelled = true
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await InstructionPrompt.system()
          expect(result.some((entry) => entry.includes("oversized-instructions"))).toBe(false)
        },
      })
      expect(state.pulls).toBeLessThanOrEqual(6)
      expect(state.cancelled).toBe(true)
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

  test("does not load instructions from a path-prefix sibling outside the project", async () => {
    await using root = await tmpdir()
    const project = path.join(root.path, "project")
    const sibling = path.join(root.path, "project-private")
    await Bun.write(path.join(project, "README.md"), "project\n")
    await Bun.write(path.join(sibling, "AGENTS.md"), "outside instructions\n")
    await Bun.write(path.join(sibling, "paper.md"), "outside paper\n")
    await Instance.provide({
      directory: project,
      fn: async () => {
        const results = await InstructionPrompt.resolve([], path.join(sibling, "paper.md"), "prefix-sibling")
        expect(results).toEqual([])
      },
    })
  })
})
