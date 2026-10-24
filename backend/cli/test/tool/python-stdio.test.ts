import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { KernelRuntime, type KernelIdentity } from "../../src/science/kernel/registry"
import "../../src/tool/notebook"
import { executionSession, fullAccessExecution, tmpdir } from "../fixture/fixture"

const binary = Bun.which(process.platform === "win32" ? "python" : "python3")

test.skipIf(!binary)(
  "Python kernel preserves Unicode and state across split Windows CRLF frames",
  async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await using access = await fullAccessExecution()
        const session = await executionSession()
        const identity: KernelIdentity = {
          projectID: Instance.project.id,
          sessionID: session.id,
          name: "python",
          language: "python",
        }
        try {
          const first = await KernelRuntime.execute(
            identity,
            'value = "中文 α →"\nprint(value)',
            { timeout: 5_000 },
            { binary: binary!, env: { PYTHONIOENCODING: "cp1252", PYTHONUTF8: "0" } },
          )
          expect(first.ok).toBe(true)
          expect(first.stdout.trim()).toBe("中文 α →")
          const second = await KernelRuntime.execute(
            identity,
            `
import os, sys, time
if sys.platform == "win32":
    def fragmented(text):
        for line in text.splitlines(keepends=True):
            os.write(sys.__stdout__.fileno(), line.removesuffix("\\n").encode("utf-8"))
            if line.endswith("\\n"):
                os.write(sys.__stdout__.fileno(), b"\\r")
                time.sleep(0.02)
                os.write(sys.__stdout__.fileno(), b"\\n")
        return len(text)
    sys.__stdout__.write = fragmented
print(value + " ✓")
`,
            { timeout: 5_000 },
          )
          expect(second.ok).toBe(true)
          expect(second.stdout.trim()).toBe("中文 α → ✓")
        } finally {
          await KernelRuntime.removeSession(identity.projectID, identity.sessionID)
        }
      },
    })
  },
  45_000,
)
