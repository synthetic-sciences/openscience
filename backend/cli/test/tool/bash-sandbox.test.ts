import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Sandbox } from "../../src/sandbox/sandbox"

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

// End-to-end through the real bash tool (not the Sandbox module in isolation):
// with sandbox enabled via project config, a command that writes outside the
// workspace must be blocked, while one that writes inside must succeed.
describe("tool.bash sandbox integration", () => {
  test("confines the bash tool's writes to the workspace", async () => {
    if (!Sandbox.available()) return // no OS backend on this platform — nothing to enforce

    await using tmp = await tmpdir({ git: true })
    // Enable the sandbox for THIS project only (never touches global config).
    fs.writeFileSync(
      path.join(tmp.path, "openscience.json"),
      JSON.stringify({ sandbox: { enabled: true, network: "deny" } }),
    )
    const outside = path.join(os.homedir(), `.openscience-bash-escape-${process.pid}`)
    fs.rmSync(outside, { force: true })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const bash = await BashTool.init()

          const inside = await bash.execute(
            { command: `printf hi > inside.txt && cat inside.txt`, description: "write inside workspace" },
            ctx,
          )
          expect(inside.metadata.exit).toBe(0)
          expect(fs.existsSync(path.join(tmp.path, "inside.txt"))).toBe(true)

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
    }
  })
})
