import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { CredentialRevocation } from "../../src/credentials/revocation"
import { CredentialTeardown } from "../../src/credentials/teardown"
import { Instance } from "../../src/project/instance"
import { CommandRuntime } from "../../src/science/command/registry"
import { Shell } from "../../src/shell/shell"
import { tmpdir } from "../fixture/fixture"

/** A real registered command whose environment never carried the synced
 * workspace overlay, registered exactly as the bash tool registers one. */
async function launch(label: string) {
  const wrapped = await CommandRuntime.wrap({
    file: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  })
  const child = spawn(wrapped.file, wrapped.args, { stdio: "ignore", detached: process.platform !== "win32" })
  const state: { exited: boolean; reason?: string } = { exited: false }
  child.once("exit", () => {
    state.exited = true
  })
  const entry = await CommandRuntime.start(
    {
      projectID: `project_${label}`,
      sessionID: `session_${label}`,
      messageID: `message_${label}`,
      description: label,
      command: label,
    },
    child,
    async (reason) => {
      state.reason = reason
      await Shell.killTree(child, { exited: () => state.exited, detached: process.platform !== "win32" })
    },
    { windowsRelease: wrapped.release },
  )
  child.once("exit", () => CommandRuntime.finish(entry.id))
  return { child, entry, state }
}

async function settle(state: { exited: boolean }, attempt = 0): Promise<boolean> {
  if (state.exited) return true
  if (attempt >= 200) return false
  await Bun.sleep(10)
  return settle(state, attempt + 1)
}

/** A live project instance whose disposal is observable. */
async function instance(directory: string, disposed: string[]) {
  const runtime = Instance.state(
    () => ({ directory: Instance.directory }),
    async (value) => {
      disposed.push(value.directory)
    },
  )
  await Instance.provide({ directory, fn: () => runtime() })
}

describe("CredentialTeardown.apply", () => {
  for (const reason of ["workspace-sync.denied", "account.replace", "settings-credential.set:github"]) {
    test(`${reason} disposes live instances and stops commands spawned without the overlay`, async () => {
      const label = reason.replace(/[^a-z0-9]+/gi, "_")
      const command = await launch(label)
      await using tmp = await tmpdir()
      const disposed: string[] = []
      await instance(tmp.path, disposed)
      try {
        await CredentialTeardown.apply({ reason })

        expect(await settle(command.state)).toBe(true)
        expect(command.state.reason).toBe(CredentialRevocation.message(reason))
        expect(command.state.reason).toStartWith(`Interrupted: credentials changed (${reason})`)
        expect(CommandRuntime.list(`project_${label}`, `session_${label}`)).toEqual([])
        expect(disposed).toEqual([tmp.path])
      } finally {
        await CommandRuntime.stopAll().catch(() => undefined)
        await Instance.provide({ directory: tmp.path, fn: () => Instance.dispose() })
      }
    })
  }

  test("an MCP authority change disposes instances but leaves shell commands running", async () => {
    const command = await launch("mcp_auth")
    await using tmp = await tmpdir()
    const disposed: string[] = []
    await instance(tmp.path, disposed)
    try {
      await CredentialTeardown.apply({ reason: "mcp-auth.tokens.refresh:linear" })

      expect(disposed).toEqual([tmp.path])
      expect(command.state.exited).toBe(false)
      expect(command.state.reason).toBeUndefined()
      expect(CommandRuntime.list("project_mcp_auth", "session_mcp_auth")).toHaveLength(1)
      expect(CredentialRevocation.message("mcp-auth.tokens.refresh:linear")).toBe(
        "Interrupted: MCP credentials changed (mcp-auth.tokens.refresh:linear) and the MCP transports that inherited the previous snapshot were stopped",
      )
    } finally {
      await CommandRuntime.stopAll().catch(() => undefined)
      await Instance.provide({ directory: tmp.path, fn: () => Instance.dispose() })
    }
  })

  test("an overlay expiry leaves instances and unstamped commands alone", async () => {
    const command = await launch("expiry_unstamped")
    await using tmp = await tmpdir()
    const disposed: string[] = []
    await instance(tmp.path, disposed)
    try {
      await CredentialTeardown.apply({ reason: "workspace-sync.expired" })

      expect(disposed).toEqual([])
      expect(command.state.exited).toBe(false)
      expect(command.state.reason).toBeUndefined()
      expect(CommandRuntime.list("project_expiry_unstamped", "session_expiry_unstamped")).toHaveLength(1)
    } finally {
      await CommandRuntime.stopAll().catch(() => undefined)
      await Instance.provide({ directory: tmp.path, fn: () => Instance.dispose() })
    }
    expect(disposed).toEqual([tmp.path])
  })
})
