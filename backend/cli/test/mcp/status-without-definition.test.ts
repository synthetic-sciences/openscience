import { expect, test } from "bun:test"
import { MCP } from "../../src/mcp"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { tmpdir } from "../fixture/fixture"

test("an enabled-only MCP entry is reported instead of vanishing, and a disabled one is simply disabled", async () => {
  await using tmp = await tmpdir()
  await Bun.write(
    `${tmp.path}/openscience.json`,
    JSON.stringify({
      mcp: {
        // Overrides a server another config layer would define; here none does.
        ghost: { enabled: false },
        orphan: { enabled: true },
      },
    }),
  )
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Project config is executable definition; it only loads for a trusted project.
      const trust = await ProjectTrust.status(Instance.project)
      await ProjectTrust.update(Instance.project, { trusted: true, root: trust.root })
      const status = await MCP.status()
      expect(status.ghost).toEqual({ status: "disabled" })
      expect(status.orphan).toMatchObject({ status: "failed", error: expect.stringContaining("No server definition") })
    },
  })
})
