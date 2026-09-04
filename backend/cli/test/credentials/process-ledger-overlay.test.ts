import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { CredentialProcessLedger } from "../../src/credentials/process-ledger"
import { CommandRuntime } from "../../src/science/command/registry"
import { Shell } from "../../src/shell/shell"

const posixTest = process.platform === "win32" ? test.skip : test

type Entry = { id: string; version: number; pid: number; identity: string; owner_pid: number; overlay?: string }

async function ledger(): Promise<Entry[]> {
  return Bun.file(CredentialProcessLedger.pathForTests()).json()
}

/** A real command child registered through the production registration path,
 * stamped with `overlay` only when the caller reports one. */
async function launch(label: string, overlay?: string) {
  const wrapped = await CommandRuntime.wrap({
    file: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  })
  const child = spawn(wrapped.file, wrapped.args, { stdio: "ignore", detached: true })
  const state = { exited: false }
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
    () => Shell.killTree(child, { exited: () => state.exited, detached: true }),
    { windowsRelease: wrapped.release, overlay },
  )
  child.once("exit", () => CommandRuntime.finish(entry.id))
  const recorded = (await ledger()).find((item) => item.id === entry.id)
  if (!recorded) throw new Error(`Command ${label} was not recorded in the credential process ledger`)
  return { child, state, id: entry.id, pid: recorded.pid, identity: recorded.identity }
}

/** The pid of a process that has already exited: a dead owner server. */
async function deadOwner(): Promise<number> {
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
  await new Promise<void>((resolve) => gone.once("exit", () => resolve()))
  return gone.pid!
}

posixTest(
  "an overlay-scoped revoke reaches stamped and legacy entries, including a dead owner's, and no others",
  async () => {
    const unstamped = await launch("unstamped")
    const stamped = await launch("stamped", "org_a")
    const legacy = await launch("legacy")
    try {
      const before = await ledger()
      expect(before.find((item) => item.id === unstamped.id)).toMatchObject({ version: 2, owner_pid: process.pid })
      expect(before.find((item) => item.id === unstamped.id)).not.toHaveProperty("overlay")
      expect(before.find((item) => item.id === stamped.id)).toMatchObject({ version: 2, overlay: "org_a" })

      // Rewrite the third entry as an earlier build wrote it: version 1, no
      // overlay field, and owned by a server that has since died.
      const owner = await deadOwner()
      const rewritten = before.map((item) =>
        item.id === legacy.id ? { ...item, version: 1, owner_pid: owner, overlay: undefined } : item,
      )
      await Bun.write(CredentialProcessLedger.pathForTests(), JSON.stringify(rewritten, null, 2))
      expect((await ledger()).find((item) => item.id === legacy.id)).toMatchObject({ version: 1, owner_pid: owner })
      expect((await ledger()).find((item) => item.id === legacy.id)).not.toHaveProperty("overlay")

      expect(await CredentialProcessLedger.revoke({ kind: "command", overlay: true })).toBe(2)

      expect(await CredentialProcessLedger.owns(stamped.pid, stamped.identity)).toBe(false)
      expect(await CredentialProcessLedger.owns(legacy.pid, legacy.identity)).toBe(false)
      expect(await CredentialProcessLedger.owns(unstamped.pid, unstamped.identity)).toBe(true)
      const after = await ledger()
      expect(after.map((item) => item.id)).toContain(unstamped.id)
      expect(after.map((item) => item.id)).not.toContain(stamped.id)
      expect(after.map((item) => item.id)).not.toContain(legacy.id)

      // An unscoped revoke still reaches the unstamped child.
      expect(await CredentialProcessLedger.revoke({ kind: "command", projectID: "project_unstamped" })).toBe(1)
      expect(await CredentialProcessLedger.owns(unstamped.pid, unstamped.identity)).toBe(false)
    } finally {
      await CommandRuntime.stopAll().catch(() => undefined)
      for (const item of [unstamped, stamped, legacy]) {
        await CredentialProcessLedger.revoke({ id: item.id }).catch(() => undefined)
        if (await CredentialProcessLedger.owns(item.pid, item.identity)) process.kill(-item.pid, "SIGKILL")
      }
    }
  },
)

posixTest("registration never infers an overlay stamp from process-wide state", async () => {
  process.env.OPENSCIENCE_LEDGER_OVERLAY_PROBE = "set"
  const child = await launch("no_inference")
  try {
    const entry = (await ledger()).find((item) => item.id === child.id)
    expect(entry).toMatchObject({ version: 2 })
    expect(entry).not.toHaveProperty("overlay")
    expect(
      await CredentialProcessLedger.revoke({ kind: "command", overlay: true, projectID: "project_no_inference" }),
    ).toBe(0)
    expect(await CredentialProcessLedger.owns(child.pid, child.identity)).toBe(true)
  } finally {
    delete process.env.OPENSCIENCE_LEDGER_OVERLAY_PROBE
    await CommandRuntime.stopAll().catch(() => undefined)
    await CredentialProcessLedger.revoke({ id: child.id }).catch(() => undefined)
    if (await CredentialProcessLedger.owns(child.pid, child.identity)) process.kill(-child.pid, "SIGKILL")
  }
})
