import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { spawn } from "../fixture/spawn"

const src = (relative: string) => JSON.stringify(new URL(`../../src/${relative}`, import.meta.url).href)

test("an overlay expiry stops only the local MCP transport whose environment carried the overlay", async () => {
  await using tmp = await tmpdir()
  const runner = `${tmp.path}/dispose-overlay.ts`
  const server = new URL("../fixture/mcp-capabilities.mjs", import.meta.url).pathname
  // The runner saves a workspace session, writes a grant, and registers MCP
  // transports in the credential process ledger. Global.Path.data follows the
  // data-root link under XDG_CONFIG_HOME, which a child inherits from this
  // process, so a private OPENSCIENCE_TEST_HOME alone would still share the
  // suite's store and ledger: give the runner every root of its own.
  const home = path.join(tmp.path, "home")
  await fs.mkdir(home, { recursive: true })
  const roots = {
    OPENSCIENCE_DATA_DIR: path.join(tmp.path, "data"),
    OPENSCIENCE_CONFIG_DIR: path.join(tmp.path, "config"),
    OPENSCIENCE_TEST_HOME: home,
    XDG_DATA_HOME: path.join(tmp.path, "xdg-data"),
    XDG_CONFIG_HOME: path.join(tmp.path, "xdg-config"),
    XDG_CACHE_HOME: path.join(tmp.path, "xdg-cache"),
    XDG_STATE_HOME: path.join(tmp.path, "xdg-state"),
  }

  await Bun.write(
    `${tmp.path}/openscience.json`,
    JSON.stringify({
      mcp: {
        before: { type: "local", command: [process.execPath, server] },
        after: { type: "local", command: [process.execPath, server], enabled: false },
      },
    }),
  )

  await Bun.write(
    runner,
    `
import { CredentialOverlay } from ${src("credentials/overlay.ts")}
import { CredentialProcessLedger } from ${src("credentials/process-ledger.ts")}
import { CredentialRevocation } from ${src("credentials/revocation.ts")}
import { MCP } from ${src("mcp/index.ts")}
import { OpenScience } from ${src("openscience/index.ts")}
import { WorkspaceCredentials } from ${src("openscience/workspace-credentials.ts")}
import { Instance } from ${src("project/instance.ts")}
import { ProjectTrust } from ${src("project/trust.ts")}
import { applyCredentialEnv } from ${src("server/routes/settings/credentials.ts")}

const session = { api_key: "osk_fixture_workspace_a", user_id: "user_a", organization_id: "org_a", workspace_locked: true }
const mcpEntries = async () =>
  (await Bun.file(CredentialProcessLedger.pathForTests()).json()).filter((entry) => entry.kind === "mcp")

const result = await Instance.provide({
  directory: process.argv[2],
  fn: async () => {
    const trust = await ProjectTrust.status(Instance.project)
    await ProjectTrust.update(Instance.project, { trusted: true, root: trust.root })
    // "before" connects while no workspace grant exists in this process.
    const initial = await MCP.status()
    const untouched = process.env.GITHUB_TOKEN ?? null
    // A workspace grant arrives: its synced GitHub token enters process.env
    // through applyCredentialEnv, which records its provenance.
    await OpenScience.saveSession(session)
    await WorkspaceCredentials.write(session, {
      organization_id: "org_a",
      auth: {},
      services: { github: { token: "fixture-cloud-github" } },
    })
    await applyCredentialEnv({ strict: true })
    const injected = process.env.GITHUB_TOKEN ?? null
    const keys = CredentialOverlay.keys().sort()
    // "after" connects with that overlay in its environment.
    await MCP.connect("after", { allowDisabled: true })
    const connected = await MCP.status()
    const stamps = (await mcpEntries()).map((entry) => entry.overlay ?? null).sort()
    const disposed = await MCP.disposeOverlay()
    const after = await MCP.status()
    const remaining = (await mcpEntries()).length
    const survivors = Object.keys(await MCP.clients())
    await MCP.disposeLocal()
    return { initial, untouched, injected, keys, connected, stamps, disposed, after, remaining, survivors, expired: CredentialRevocation.EXPIRED }
  },
})
process.stdout.write(JSON.stringify(result))
process.exit(0)
`,
  )

  const proc = spawn([process.execPath, runner, tmp.path], {
    cwd: tmp.path,
    env: roots,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [output, error, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(exit, error).toBe(0)
  const result = JSON.parse(output)

  expect(result.initial, error).toEqual({ before: { status: "connected" }, after: { status: "disabled" } })
  expect(result.untouched).toBeNull()
  expect(result.injected).toBe("fixture-cloud-github")
  expect(result.keys).toEqual(["GH_TOKEN", "GITHUB_TOKEN"])
  expect(result.connected).toEqual({ before: { status: "connected" }, after: { status: "connected" } })
  // Exactly one transport was stamped: the one launched with the overlay.
  expect(result.stamps).toEqual([null, "org_a"])
  expect(result.disposed).toBe(1)
  expect(result.after).toEqual({
    before: { status: "connected" },
    after: { status: "failed", error: result.expired },
  })
  expect(result.survivors).toEqual(["before"])
  expect(result.remaining).toBe(1)
}, 30_000)
