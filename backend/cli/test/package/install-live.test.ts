import { describe, expect, test } from "bun:test"
import { Environment } from "../../src/package/environment"
import { Installer } from "../../src/package/installer"
import { Refuse } from "../../src/package/refuse"
import { Instance } from "../../src/project/instance"
import { Sandbox } from "../../src/sandbox/sandbox"
import { PackageTool } from "../../src/tool/package"
import type { PermissionNext } from "../../src/permission/next"
import { executionSession, tmpdir } from "../fixture/fixture"

/**
 * The merge gate, stated as an assertion.
 *
 * The condition this branch has to meet is that a package installs **with the
 * user's approval**, under `network: "allowlist"`, on every platform we ship.
 * Everything else in `test/package/` tests a component; this tests the claim.
 *
 * Both halves are asserted together on purpose. A green install with an open
 * shell bypass is not the gate met — an agent that never calls the tool never
 * shows a card, so the refusal is part of the same claim, not an adjacent
 * feature.
 *
 * Gated on a real sandbox backend and a real interpreter, and skips rather than
 * fails without them: a green run on a machine with no sandbox would assert
 * nothing. On Linux and macOS CI both are present, so it runs unskipped there.
 */

const python = Bun.which("python3")
const skip = Sandbox.backend() === "none" || !python

async function approving() {
  const session = await executionSession()
  const asks: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
  return {
    asks,
    ctx: {
      sessionID: session.id,
      messageID: "",
      callID: "",
      agent: "research",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => {},
      ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
        asks.push(req)
      },
    },
  }
}

describe.skipIf(skip)("merge gate: a governed install under network allowlist", () => {
  test("the agent's only install route asks for approval and lands the package", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await PackageTool.init()
        const { asks, ctx } = await approving()
        const result = await tool.execute(
          { packages: ["tqdm"], environment: "gate", language: "python", source: false, wait: true },
          ctx,
        )

        // Approval happened, and it named exactly what ran.
        expect(asks).toHaveLength(1)
        expect(asks[0]!.permission).toBe("package_install")
        expect(asks[0]!.patterns).toEqual(["install tqdm → gate [pypi.org/simple]"])

        // The package really landed — read back out of the environment, not
        // taken from pip's exit code.
        expect(result.metadata.versions["tqdm"]).toMatch(/^\d/)
        const directory = Environment.directory(Instance.project.id, "gate")
        expect((await Installer.verify(directory, ["tqdm"]))["tqdm"]).toMatch(/^\d/)

        // And it happened under the allowlist policy, not with the sandbox off.
        const policy = await (await import("../../src/config/config")).Config.trustedSandbox()
        expect(policy.network ?? "allowlist").toBe("allowlist")
      },
    })
  }, 600_000)

  test("the shell route to the same install is refused", () => {
    // The exact line measured to succeed on feat/sandbox-network-policy before
    // any of this existed: a venv in the writable workspace, pypi allowlisted,
    // no tool and no card. If this ever returns undefined the gate is not met
    // even when the test above is green.
    expect(Refuse.installer(["/w/venv/bin/pip", "install", "tqdm"])).toBeString()
    expect(Refuse.installer(["pip", "install", "tqdm"])).toBeString()
    expect(Refuse.installer(["uv", "pip", "install", "tqdm"])).toBeString()
    expect(Refuse.installer(["python3", "-m", "pip", "install", "tqdm"])).toBeString()
  })

  test("a package with no wheel under the default policy fails with a translated message", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const directory = Environment.directory(Instance.project.id, "nowheel")
        await Installer.create(directory, await Installer.probe(directory))
        const result = await Installer.install({
          directory,
          packages: ["this-package-does-not-exist-anywhere-xyzzy"],
          index: "",
          source: false,
        })
        expect(result.ok).toBe(false)
        // The raw log reads as "no such package" regardless of which of the
        // two things actually happened, which is why explain() exists.
        expect(Installer.explain(result.log).length).toBeGreaterThan(0)
      },
    })
  }, 600_000)
})
