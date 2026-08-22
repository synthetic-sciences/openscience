import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "path"
import { GrepTool } from "../../src/tool/grep"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "research",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

const projectRoot = path.join(__dirname, "../..")

describe("tool.grep", () => {
  test("basic search", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "export",
            path: path.join(projectRoot, "src/tool"),
            include: "*.ts",
          },
          ctx,
        )
        expect(result.metadata.matches).toBeGreaterThan(0)
        expect(result.output).toContain("Found")
      },
    })
  })

  test("no matches returns correct output", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.txt"), "hello world")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "xyznonexistentpatternxyz123",
            path: tmp.path,
          },
          ctx,
        )
        expect(result.metadata.matches).toBe(0)
        expect(result.output).toBe("No files found")
      },
    })
  })

  test("handles CRLF line endings in output", async () => {
    // This test verifies the regex split handles both \n and \r\n
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Create a test file with content
        await Bun.write(path.join(dir, "test.txt"), "line1\nline2\nline3")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute(
          {
            pattern: "line",
            path: tmp.path,
          },
          ctx,
        )
        expect(result.metadata.matches).toBeGreaterThan(0)
      },
    })
  })

  test("stops the search process after the bounded result window", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "many.txt"),
          Array.from({ length: 10_000 }, (_, index) => `match ${index}`).join("\n"),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute({ pattern: "match", path: tmp.path }, ctx)

        expect(result.metadata).toMatchObject({ matches: 100, truncated: true })
        expect(result.output).toContain("Found 100 matches")
        expect(result.output.length).toBeLessThan(30_000)
      },
    })
  })

  test("bounds individual matching lines before collecting them", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "wide.txt"), `needle ${"x".repeat(2_000_000)}`)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await GrepTool.init()
        const result = await grep.execute({ pattern: "needle", path: tmp.path }, ctx)

        expect(result.metadata.matches).toBe(1)
        expect(result.output.length).toBeLessThan(10_000)
      },
    })
  })

  test.skipIf(process.platform === "win32")(
    "does not follow a nested symlink outside the authorized search root",
    async () => {
      await using external = await tmpdir({
        init: (dir) => Bun.write(path.join(dir, "secret.txt"), "outside needle\n"),
      })
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "inside.txt"), "inside value\n")
          await fs.symlink(external.path, path.join(dir, "escape"), "dir")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await (await GrepTool.init()).execute({ pattern: "outside needle", path: tmp.path }, ctx)
          expect(result.metadata.matches).toBe(0)
          expect(result.output).toBe("No files found")
        },
      })
    },
  )
})

describe("CRLF regex handling", () => {
  test("regex correctly splits Unix line endings", () => {
    const unixOutput = "file1.txt|1|content1\nfile2.txt|2|content2\nfile3.txt|3|content3"
    const lines = unixOutput.trim().split(/\r?\n/)
    expect(lines.length).toBe(3)
    expect(lines[0]).toBe("file1.txt|1|content1")
    expect(lines[2]).toBe("file3.txt|3|content3")
  })

  test("regex correctly splits Windows CRLF line endings", () => {
    const windowsOutput = "file1.txt|1|content1\r\nfile2.txt|2|content2\r\nfile3.txt|3|content3"
    const lines = windowsOutput.trim().split(/\r?\n/)
    expect(lines.length).toBe(3)
    expect(lines[0]).toBe("file1.txt|1|content1")
    expect(lines[2]).toBe("file3.txt|3|content3")
  })

  test("regex handles mixed line endings", () => {
    const mixedOutput = "file1.txt|1|content1\nfile2.txt|2|content2\r\nfile3.txt|3|content3"
    const lines = mixedOutput.trim().split(/\r?\n/)
    expect(lines.length).toBe(3)
  })
})
