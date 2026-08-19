import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { executionSession, tmpdir } from "../fixture/fixture"
import { Sandbox } from "../../src/sandbox/sandbox"
import { SessionFilesystem } from "../../src/session/filesystem"

async function context() {
  const session = await executionSession()
  return {
    sessionID: session.id,
    messageID: "",
    callID: "",
    agent: "research" as const,
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => {},
    ask: async () => {},
  }
}

// End-to-end through the real bash tool (not the Sandbox module in isolation):
// with the sandbox enabled, a command that writes outside the workspace must be
// blocked, while one that writes inside must succeed. The sandbox policy is read
// only from trusted (global + managed) config — never project config — so we
// enable it via the test-isolated managed config dir, not a project file.
describe("tool.bash sandbox integration", () => {
  test("confines the bash tool's writes to the workspace", async () => {
    if (!Sandbox.available()) return // no OS backend on this platform — nothing to enforce

    await using tmp = await tmpdir({ git: true })
    const managedDir = process.env.OPENSCIENCE_TEST_MANAGED_CONFIG_DIR!
    const managedFile = path.join(managedDir, "openscience.json")
    fs.mkdirSync(managedDir, { recursive: true })
    fs.writeFileSync(managedFile, JSON.stringify({ sandbox: { enabled: true, network: "deny" } }))

    const outside = path.join(os.homedir(), `.openscience-bash-escape-${process.pid}`)
    fs.rmSync(outside, { force: true })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ctx = await context()
          const workspace = await SessionFilesystem.workspace(ctx.sessionID)
          const bash = await BashTool.init()

          const inside = await bash.execute(
            { command: `printf hi > inside.txt && cat inside.txt`, description: "write inside workspace" },
            ctx,
          )
          expect(inside.metadata.exit).toBe(0)
          expect(fs.existsSync(path.join(workspace, "inside.txt"))).toBe(true)

          if (Bun.which("python3")) {
            const python = await bash.execute(
              {
                command: `python -c "import encodings; print('runtime-ok')"`,
                description: "check canonical Python runtime",
              },
              ctx,
            )
            expect(python.metadata.exit).toBe(0)
            expect(python.output).toContain("runtime-ok")
          }

          const escape = await bash.execute(
            { command: `printf x > "${outside}"`, description: "write outside workspace" },
            ctx,
          )
          expect(escape.metadata.exit).not.toBe(0)
          expect(fs.existsSync(outside)).toBe(false)
        },
      })
    } finally {
      fs.rmSync(outside, { force: true })
      // don't leak "sandbox on" into any test that runs after this one
      fs.rmSync(managedFile, { force: true })
    }
  }, 15_000)
})
