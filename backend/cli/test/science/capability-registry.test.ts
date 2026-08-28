import { describe, expect, test } from "bun:test"
import { CapabilityRegistry } from "../../src/science/capability/registry"

describe("scientific capability registry", () => {
  test("lists a small truthful catalog without claiming verification", () => {
    const items = CapabilityRegistry.list()
    expect(items).toHaveLength(6)
    expect(items.every((item) => item.status === "experimental" || item.status === "blocked")).toBe(true)
    expect(items.map((item) => item.id)).toContain("alphafold2")
  })

  test("loads versioned detail lazily", async () => {
    const item = await CapabilityRegistry.describe("rdkit")
    expect(item).toMatchObject({ schema_version: 1, id: "rdkit", version: "1.0.0", status: "experimental" })
    expect(item?.execution?.packages).toEqual(["rdkit==2026.3.5"])
    expect(await CapabilityRegistry.describe("not-real")).toBeUndefined()
  })

  test("compiles a proposal into compute_job without dispatching", async () => {
    const result = await CapabilityRegistry.plan("scipy", {
      name: "Fit model",
      purpose: "Fit and validate the requested model.",
      command: "python analysis.py",
      target: { kind: "modal" },
      uploads: ["analysis.py"],
      artifacts: ["results.json"],
      packages: ["pandas==2.3.2"],
    })
    expect(result.tool).toBe("compute_job")
    expect(result.input).toMatchObject({
      action: "plan",
      target: { kind: "modal" },
      packages: ["scipy==1.18.1", "pandas==2.3.2"],
    })
    await expect(
      CapabilityRegistry.plan("scipy", {
        name: "Unpinned model",
        purpose: "Reject an environment that cannot be reproduced.",
        command: "python analysis.py",
        target: { kind: "modal" },
        packages: ["pandas"],
      }),
    ).rejects.toThrow("exact version pin")
  })

  test("refuses blocked and unsupported execution routes", async () => {
    const common = {
      name: "Run",
      purpose: "Run the requested workflow.",
      command: "python analysis.py",
    }
    await expect(CapabilityRegistry.plan("alphafold2", { ...common, target: { kind: "modal" } })).rejects.toThrow(
      "reviewed runtime image",
    )
    await expect(CapabilityRegistry.plan("scipy", { ...common, target: { kind: "local" } })).rejects.toThrow(
      "currently supports",
    )
  })
})
