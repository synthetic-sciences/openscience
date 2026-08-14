import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProcessIdentity } from "../../src/process/process-identity"

test.skipIf(process.platform !== "linux")(
  "a zombie keeps its start identity but is not a live process owner",
  async () => {
    const python = Bun.which("python3")
    if (!python) return
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-process-zombie-"))
    const marker = path.join(root, "child.pid")
    const script = [
      "import os, sys, time",
      "child = os.fork()",
      "if child == 0: os._exit(0)",
      "open(sys.argv[1], 'w').write(str(child))",
      "time.sleep(60)",
    ].join("\n")
    const parent = Bun.spawn([python, "-c", script, marker], { stdout: "ignore", stderr: "pipe" })
    try {
      let child = 0
      for (let attempt = 0; attempt < 300; attempt++) {
        child = Number(
          await Bun.file(marker)
            .text()
            .catch(() => "0"),
        )
        if (child) break
        await Bun.sleep(10)
      }
      expect(child).toBeGreaterThan(0)
      for (let attempt = 0; attempt < 300; attempt++) {
        const stat = await Bun.file(`/proc/${child}/stat`)
          .text()
          .catch(() => "")
        const fields = stat
          .slice(stat.lastIndexOf(")") + 2)
          .trim()
          .split(/\s+/)
        if (fields[0] === "Z") break
        await Bun.sleep(10)
      }
      const stat = await Bun.file(`/proc/${child}/stat`).text()
      expect(
        stat
          .slice(stat.lastIndexOf(")") + 2)
          .trim()
          .split(/\s+/)[0],
      ).toBe("Z")
      const identity = await ProcessIdentity.capture(child)
      expect(identity).toMatch(/^[a-f0-9]{64}$/)
      expect(await ProcessIdentity.owns(child, identity)).toBe(false)
    } finally {
      parent.kill("SIGKILL")
      await parent.exited
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)
