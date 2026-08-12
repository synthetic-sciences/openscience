import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { File } from "../../src/file"
import { CredentialProcessLedger } from "../../src/credentials/process-ledger"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { Sandbox } from "../../src/sandbox/sandbox"
import { FileRoutes } from "../../src/server/routes/file"
import { tmpdir } from "../fixture/fixture"

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!alive(pid)) return
    await Bun.sleep(10)
  }
  throw new Error(`scientific preview descendant ${pid} remained alive`)
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

describe("File.inspect", () => {
  test("recognizes H5AD containers and reports local inspection capabilities", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const signature = Uint8Array.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
        await Bun.write(path.join(directory, "cells.h5ad"), signature)
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.inspect("cells.h5ad")
        expect(result).toMatchObject({
          format: "h5ad",
          name: "cells.h5ad",
          size: 12,
          signature: true,
          tool: { name: "h5py" },
        })
        expect(typeof result.tool.available).toBe("boolean")
      },
    })
  })

  test.skipIf(!Bun.which("python3") && !Bun.which("python"))(
    "an untrusted preview cannot import a project-controlled h5py module",
    async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (directory) => {
          const marker = path.join(directory, "h5py-imported-before-trust")
          const signature = Uint8Array.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
          await Bun.write(path.join(directory, "cells.h5ad"), signature)
          await Bun.write(
            path.join(directory, "h5py.py"),
            `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("executed")\n`,
          )
          return { marker }
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await ProjectTrust.update(Instance.project, { trusted: false })
          const previous = process.env.PYTHONPATH
          process.env.PYTHONPATH = tmp.path
          try {
            const response = await FileRoutes().request("/file/inspect?path=cells.h5ad")
            expect(response.status).toBe(200)
            const result = (await response.json()) as Awaited<ReturnType<typeof File.inspect>>
            expect(result).toMatchObject({
              signature: true,
              tool: { name: "h5py", available: false },
              details: {},
            })
            expect(result.tool.detail).toContain("Trust this project")
            expect(await Bun.file(tmp.extra.marker).exists()).toBe(false)
          } finally {
            restoreEnv("PYTHONPATH", previous)
          }
        },
      })
    },
  )

  test.skipIf(process.platform === "win32")(
    "trusted inspection has a minimal environment and reaps background descendants",
    async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (directory) => {
          const bin = path.join(directory, "preview-bin")
          await fs.mkdir(bin, { recursive: true })
          const python = path.join(bin, "python3")
          await Bun.write(
            python,
            `#!/bin/sh\nsleep 30 </dev/null >/dev/null 2>&1 &\npid=$!\nprintf '{"summary":{"secret":"%s","pythonpath":"%s","cwd":"%s","pid":%s}}' "\${OPENAI_API_KEY-unset}" "\${PYTHONPATH-unset}" "$PWD" "$pid"\n`,
          )
          await fs.chmod(python, 0o755)
          const signature = Uint8Array.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
          await Bun.write(path.join(directory, "cells.h5ad"), signature)
          return { bin }
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const status = await ProjectTrust.status(Instance.project)
          await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
          const previous = {
            PATH: process.env.PATH,
            OPENAI_API_KEY: process.env.OPENAI_API_KEY,
            PYTHONPATH: process.env.PYTHONPATH,
          }
          process.env.PATH = `${tmp.extra.bin}${path.delimiter}${previous.PATH ?? ""}`
          process.env.OPENAI_API_KEY = "must-not-enter-preview"
          process.env.PYTHONPATH = tmp.path
          try {
            const result = await File.inspect("cells.h5ad")
            expect(result.tool).toMatchObject({ name: "h5py", available: true })
            const summary = result.details.summary as Record<string, unknown>
            expect(summary.secret).toBe("unset")
            expect(summary.pythonpath).toBe("unset")
            expect(summary.cwd).not.toBe(tmp.path)
            const pid = Number(summary.pid)
            expect(Number.isSafeInteger(pid)).toBe(true)
            if (Sandbox.backend() !== "bubblewrap") await waitForExit(pid)

            const ledger = await Bun.file(CredentialProcessLedger.pathForTests())
              .json()
              .catch(() => [])
            expect(
              (ledger as Array<{ kind?: string; project_id?: string }>).some(
                (entry) => entry.kind === "command" && entry.project_id === Instance.project.id,
              ),
            ).toBe(false)
          } finally {
            restoreEnv("PATH", previous.PATH)
            restoreEnv("OPENAI_API_KEY", previous.OPENAI_API_KEY)
            restoreEnv("PYTHONPATH", previous.PYTHONPATH)
          }
        },
      })
    },
    30_000,
  )

  test("recognizes CRAM version bytes and adjacent indexes", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "sample.cram"), Uint8Array.from([0x43, 0x52, 0x41, 0x4d, 3, 1, 0, 0]))
        await Bun.write(path.join(directory, "sample.cram.crai"), "index")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.inspect("sample.cram")
        expect(result).toMatchObject({
          format: "cram",
          signature: true,
          index: "sample.cram.crai",
          details: { version: "3.1" },
          tool: { name: "samtools" },
        })
      },
    })
  })

  test("recognizes BAM and conventional index names", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "sample.bam"), Uint8Array.from([0x1f, 0x8b, 8, 4, 0, 0, 0, 0]))
        await Bun.write(path.join(directory, "sample.bai"), "index")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.inspect("sample.bam")
        expect(result).toMatchObject({
          format: "bam",
          signature: true,
          index: "sample.bai",
          tool: { name: "samtools" },
        })
      },
    })
  })

  test("rejects unsupported extensions and paths outside the project", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "notes.bin"), "content")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(File.inspect("notes.bin")).rejects.toThrow("Unsupported scientific binary format")
        await expect(File.inspect("../../outside.h5ad")).rejects.toThrow("Access denied")
      },
    })
  })
})

describe("large binary reads", () => {
  test("returns metadata instead of base64-loading files above the preview limit", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const file = Bun.file(path.join(directory, "large.bam"))
        const writer = file.writer()
        writer.write(Uint8Array.from([0x1f, 0x8b, 8, 4]))
        writer.write(new Uint8Array(16 * 1024 * 1024))
        await writer.end()
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.read("large.bam")
        expect(result.encoding).toBe("base64")
        expect(result.content).toBe("")
        expect(result.truncated).toBe(true)
        expect(result.size).toBeGreaterThan(16 * 1024 * 1024)
      },
    })
  })
})

describe("large text reads", () => {
  test("returns a bounded read-only preview instead of loading the whole scientific file", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const writer = Bun.file(path.join(directory, "variants.vcf")).writer()
        const chunk = new TextEncoder().encode("chr1\t1\t.\tA\tG\t60\tPASS\tDP=20\n".repeat(32_768))
        for (const _ of Array.from({ length: 10 })) writer.write(chunk)
        await writer.end()
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.read("variants.vcf")
        expect(result.truncated).toBe(true)
        expect(result.size).toBeGreaterThan(8 * 1024 * 1024)
        expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(8 * 1024 * 1024)
      },
    })
  })
})
