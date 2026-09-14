import { expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { applyPatch } from "diff"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { Format } from "../../src/format"
import { Instance } from "../../src/project/instance"
import { SafeDirectoryIO } from "../../src/file/safe-directory-io"
import { Sandbox } from "../../src/sandbox/sandbox"
import { fullAccessExecution, tmpdir, trustProject } from "../fixture/fixture"

const context = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "research",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

test("patch results bind actual formatter output while permissions retain the proposal", async () => {
  await using policy = Sandbox.available() ? undefined : await fullAccessExecution()
  await using fixture = await tmpdir({
    config: {
      lsp: false,
      formatter: {
        receipt: { command: [process.execPath, "formatter.cjs", "$FILE"], extensions: [".receipt"] },
      },
    },
    init: async (directory) => {
      await fs.writeFile(
        path.join(directory, "formatter.cjs"),
        `const fs = require("node:fs"); const file = process.argv[2]; fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8")), null, 2) + "\\n");`,
      )
    },
  })
  await Instance.provide({
    directory: fixture.path,
    fn: async () => {
      await trustProject()
      Format.init()
      const tool = await ApplyPatchTool.init()
      const proposed: string[] = []
      const ctx = {
        ...context,
        ask: async (input: { metadata: Record<string, unknown> }) => {
          const files = input.metadata.files as Array<{ after: string }>
          proposed.push(files[0].after)
        },
      }
      const patches = [
        '*** Begin Patch\n*** Add File: data.receipt\n+{"value":1}\n*** End Patch',
        '*** Begin Patch\n*** Update File: data.receipt\n@@\n-  "value": 1\n+  "value":2\n*** End Patch',
        '*** Begin Patch\n*** Update File: data.receipt\n*** Move to: renamed.receipt\n@@\n-  "value": 2\n+  "value":3\n*** End Patch',
      ]
      for (const [index, patchText] of patches.entries()) {
        const result = await tool.execute({ patchText }, ctx)
        const target = index === 2 ? "renamed.receipt" : "data.receipt"
        const actual = await fs.readFile(path.join(fixture.path, target), "utf8")
        const receipt = result.metadata.files[0]
        expect(actual).toBe(JSON.stringify({ value: index + 1 }, null, 2) + "\n")
        expect(receipt.after).toBe(actual)
        expect(receipt.after).not.toBe(proposed[index])
        expect(applyPatch(receipt.before, receipt.diff)).toBe(actual)
        expect(receipt.afterHash).toBe(crypto.createHash("sha256").update(actual).digest("hex"))
        expect(receipt.formatted).toBe(true)
        expect(result.output).toContain(`Current SHA-256: ${receipt.afterHash}`)
        // A short formatting diff still travels to the model in full.
        expect(result.output).toContain(`+  "value": ${index + 1}`)
        expect(result.metadata.formatting?.[target]).toContain(`+  "value": ${index + 1}`)
      }
      // A formatter that rewrites a large file sends the model the regions
      // that changed, not the whole rewrite; the UI keeps the diff.
      const lines = Array.from({ length: 400 }, (_, index) => `"k${index}":${index}`)
      const big = await tool.execute(
        { patchText: `*** Begin Patch\n*** Add File: big.receipt\n+{${lines.join(",")}}\n*** End Patch` },
        ctx,
      )
      expect(big.output).toMatch(/Formatting changed lines 1(-\d+)?(, |;)/)
      expect(big.output).toContain("re-read those regions before patching them again")
      expect(big.output.length).toBeLessThan(1_200)
      expect(big.metadata.formatting?.["big.receipt"].split("\n").length).toBeGreaterThan(400)
      await Instance.dispose()
    },
  })
})

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "whole-file updates and same-path replacements never disappear from a concurrent reader",
  async () => {
    await using fixture = await tmpdir({ config: { lsp: false, formatter: false } })
    const target = path.join(fixture.path, "shared.txt")
    const ready = path.join(fixture.path, "reader-ready")
    const stop = path.join(fixture.path, "reader-stop")
    const readerPath = path.join(fixture.path, "reader.cjs")
    const contents = ["old\n", "new\n"]
    await fs.writeFile(target, contents[0])
    await fs.writeFile(
      readerPath,
      `const fs = require("node:fs");
const [target, ready, stop] = process.argv.slice(2);
const seen = new Set(); let reads = 0;
const deadline = Date.now() + 10000;
try {
  while (!fs.existsSync(stop) && Date.now() < deadline) {
    const text = fs.readFileSync(target, "utf8");
    if (text !== "old\\n" && text !== "new\\n") throw new Error("partial contents");
    seen.add(text); reads++;
    if (reads === 1) fs.writeFileSync(ready, "ready");
  }
  if (!fs.existsSync(stop)) throw new Error("reader deadline");
  console.log(JSON.stringify({ reads, seen: [...seen] }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
`,
    )
    const reader = Bun.spawn([process.execPath, readerPath, target, ready, stop], { stdout: "pipe", stderr: "pipe" })
    try {
      for (let attempt = 0; attempt < 200 && !(await Bun.file(ready).exists()); attempt++) await Bun.sleep(10)
      expect(await Bun.file(ready).exists()).toBe(true)
      await Instance.provide({
        directory: fixture.path,
        fn: async () => {
          const tool = await ApplyPatchTool.init()
          for (let index = 0; index < 12; index++) {
            const previous = contents[index % 2].trim()
            const next = contents[(index + 1) % 2].trim()
            const patchText =
              index % 2 === 0
                ? `*** Begin Patch\n*** Update File: shared.txt\n@@\n-${previous}\n+${next}\n*** End Patch`
                : `*** Begin Patch\n*** Delete File: shared.txt\n*** Add File: ./shared.txt\n+${next}\n*** End Patch`
            const result = await tool.execute({ patchText }, context)
            expect(result.metadata.files).toHaveLength(1)
            expect(result.metadata.files[0].type).toBe("update")
            expect(result.metadata.trash).toEqual([])
          }
          expect(await fs.readFile(target, "utf8")).toBe(contents[0])
          expect((await fs.readdir(fixture.path)).filter((name) => name.startsWith(".openscience-"))).toEqual([])
          await Instance.dispose()
        },
      })
      await fs.writeFile(stop, "stop")
      const [code, stdout, stderr] = await Promise.all([
        reader.exited,
        new Response(reader.stdout).text(),
        new Response(reader.stderr).text(),
      ])
      expect(stderr).toBe("")
      expect(code).toBe(0)
      const receipt = JSON.parse(stdout) as { reads: number; seen: string[] }
      expect(receipt.reads).toBeGreaterThan(12)
      expect(receipt.seen.toSorted()).toEqual(contents.toSorted())
    } finally {
      reader.kill()
      await reader.exited
    }
  },
)

for (const phase of ["before", "after"] as const) {
  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    `atomic replacement preserves another writer's bytes changed ${phase} exchange`,
    async () => {
      await using fixture = await tmpdir({ config: { lsp: false, formatter: false } })
      const target = path.join(fixture.path, "shared.txt")
      await fs.writeFile(target, "approved\n")
      const exchange = SafeDirectoryIO.swapEntries
      const barrier = spyOn(SafeDirectoryIO, "swapEntries").mockImplementation(
        (left, right, expectedLeft, expectedRight, options) =>
          exchange(left, right, expectedLeft, expectedRight, {
            ...options,
            afterVerify: async (a, b) => {
              if (phase === "before") await fs.writeFile(a, "concurrent writer\n")
              await options?.afterVerify?.(a, b)
            },
            afterMutation: async (a, b) => {
              if (phase === "after") await fs.writeFile(b, "concurrent writer\n")
              await options?.afterMutation?.(a, b)
            },
          }),
      )
      try {
        await Instance.provide({
          directory: fixture.path,
          fn: async () => {
            const tool = await ApplyPatchTool.init()
            await expect(
              tool.execute(
                {
                  patchText:
                    "*** Begin Patch\n*** Delete File: shared.txt\n*** Add File: shared.txt\n+proposed\n*** End Patch",
                },
                context,
              ),
            ).rejects.toThrow("changed after approval")
            expect(await fs.readFile(target, "utf8")).toBe("concurrent writer\n")
            expect((await fs.readdir(fixture.path)).filter((name) => name.startsWith(".openscience-"))).toEqual([])
            await Instance.dispose()
          },
        })
      } finally {
        barrier.mockRestore()
      }
    },
  )
}

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "failed patch rollback preserves a concurrent edit to the installed public inode",
  async () => {
    await using fixture = await tmpdir({ config: { lsp: false, formatter: false } })
    const target = path.join(fixture.path, "shared.txt")
    await fs.writeFile(target, "approved\n")
    const original = await fs.stat(target, { bigint: true })
    const retained: { file?: string } = {}
    const exchange = SafeDirectoryIO.swapEntries
    const barrier = spyOn(SafeDirectoryIO, "swapEntries").mockImplementation(
      (left, right, expectedLeft, expectedRight, options) =>
        exchange(left, right, expectedLeft, expectedRight, {
          ...options,
          afterMutation: async (a, b) => {
            expect(await fs.readFile(a, "utf8")).toBe("proposed\n")
            const installed = await fs.stat(a, { bigint: true })
            await fs.writeFile(a, "concurrent writer\n")
            expect((await fs.stat(a, { bigint: true })).ino).toBe(installed.ino)
            retained.file = b
            await options?.afterMutation?.(a, b)
          },
        }),
    )
    try {
      await Instance.provide({
        directory: fixture.path,
        fn: async () => {
          try {
            const tool = await ApplyPatchTool.init()
            await expect(
              tool.execute(
                { patchText: "*** Begin Patch\n*** Update File: shared.txt\n@@\n-approved\n+proposed\n*** End Patch" },
                context,
              ),
            ).rejects.toThrow("could not be rolled back")
            expect(await fs.readFile(target, "utf8")).toBe("concurrent writer\n")
            expect(retained.file).toBeDefined()
            expect(await fs.readFile(retained.file!, "utf8")).toBe("approved\n")
            expect((await fs.stat(retained.file!, { bigint: true })).ino).toBe(original.ino)
            expect((await fs.readdir(fixture.path)).filter((name) => name.startsWith(".openscience-"))).toEqual([
              path.basename(retained.file!),
            ])
          } finally {
            await Instance.dispose()
          }
        },
      })
    } finally {
      barrier.mockRestore()
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "same-path Delete+Add fails closed where atomic exchange is unavailable",
  async () => {
    await using fixture = await tmpdir({ config: { lsp: false, formatter: false } })
    const target = path.join(fixture.path, "shared.txt")
    await fs.writeFile(target, "approved\n")
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const tool = await ApplyPatchTool.init()
        await expect(
          tool.execute(
            {
              patchText:
                "*** Begin Patch\n*** Delete File: shared.txt\n*** Add File: shared.txt\n+proposed\n*** End Patch",
            },
            context,
          ),
        ).rejects.toThrow("Use one Update File section")
        expect(await fs.readFile(target, "utf8")).toBe("approved\n")
        await Instance.dispose()
      },
    })
  },
)
