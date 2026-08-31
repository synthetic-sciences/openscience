import { describe, expect, test } from "bun:test"
import {
  actionableScientificCapabilities,
  capabilityState,
  scientificCapabilityTarget,
  type ScientificCapabilityRecord,
} from "./scientific-tools-state"

const item = (overrides: Partial<ScientificCapabilityRecord> = {}): ScientificCapabilityRecord => ({
  schema_version: 2,
  id: "scipy",
  version: "2.0.0",
  name: "SciPy",
  category: "analysis",
  summary: "Numerical analysis",
  maturity: "experimental",
  current_availability: { local: "setup_needed", hosted: "setup_needed" },
  basis: "Packaged scientific runtime.",
  source: { kind: "pypi", name: "scipy", version: "1.18.1", reference: "https://pypi.org/project/scipy/1.18.1/" },
  runtime: {
    pack_id: "core-science-py312-v1",
    python: "3.12.11",
    image: "image@sha256:x",
    lock_digest: "x",
    packages: ["scipy==1.18.1"],
    targets: ["local", "modal"],
  },
  ...overrides,
})

describe("scientific tools settings state", () => {
  test("keeps only capabilities with a real executable path", () => {
    const records = [
      item(),
      item({
        id: "boltz2",
        name: "Boltz-2",
        runtime: undefined,
        current_availability: { local: "unavailable", hosted: "setup_needed" },
        hosted: {
          kind: "nvidia_nim",
          adapter_id: "boltz2",
          credential: "nvidia_nim",
          docs_url: "https://docs.api.nvidia.com/nim/reference/mit-boltz2-infer",
          terms_url: "https://example.com/terms",
        },
      }),
      item({
        id: "alphafold2",
        name: "AlphaFold2",
        runtime: undefined,
        maturity: "blocked",
        current_availability: { local: "unavailable", hosted: "unavailable" },
      }),
      item({
        id: "open-babel",
        name: "Open Babel",
        runtime: undefined,
        current_availability: { local: "setup_needed", hosted: "unavailable" },
      }),
    ]
    expect(actionableScientificCapabilities(records).map((value) => value.id)).toEqual(["scipy", "boltz2"])
    expect(scientificCapabilityTarget(records[0])).toBe("local")
    expect(scientificCapabilityTarget(records[1])).toBe("nvidia")
    expect(scientificCapabilityTarget(records[2])).toBeUndefined()
    expect(scientificCapabilityTarget(records[3])).toBeUndefined()
  })

  test("summarizes executable availability and its real setup action", () => {
    expect(capabilityState(item())).toMatchObject({ label: "Not installed", action: "setup" })
    expect(capabilityState(item({ maturity: "blocked" }))).toMatchObject({ label: "Unavailable" })
    expect(capabilityState(item({ current_availability: { local: "ready", hosted: "setup_needed" } }))).toMatchObject({
      label: "Ready",
    })
    expect(
      capabilityState(item({ current_availability: { local: "degraded", hosted: "setup_needed" } })),
    ).toMatchObject({
      label: "Needs attention",
      action: "setup",
    })
  })

  test("distinguishes an NVIDIA credential connection from verified runtime readiness", () => {
    const hosted = item({
      runtime: undefined,
      hosted: {
        kind: "nvidia_nim",
        adapter_id: "genmol",
        credential: "nvidia_nim",
        docs_url: "https://docs.api.nvidia.com/nim/reference/nvidia-genmol-infer",
        terms_url: "https://example.com/terms",
      },
      current_availability: { local: "unavailable", hosted: "configured" },
    })
    expect(capabilityState(hosted)).toMatchObject({ label: "Connected", tone: "neutral", action: undefined })
    expect(
      capabilityState({ ...hosted, current_availability: { local: "unavailable", hosted: "setup_needed" } }),
    ).toMatchObject({ label: "Setup needed", action: "credentials" })
  })

  test("wires installation and account setup without remote catalog polling", async () => {
    const [component, loader, logos] = await Promise.all([
      Bun.file(new URL("./ScientificTools.tsx", import.meta.url)).text(),
      Bun.file(new URL("./scientific-tools-loader.ts", import.meta.url)).text(),
      Bun.file(new URL("./ScientificToolLogo.tsx", import.meta.url)).text(),
    ])
    expect(component).toContain("setupScientificTool")
    expect(component).toContain('navigate(target() === "modal" ? "compute" : "credentials")')
    expect(loader).toContain('method: "POST"')
    expect(component).not.toContain("setInterval")
    expect(logos).toContain("https://github.com/scipy/scipy/")
    expect(logos).toContain("https://github.com/rdkit/rdkit/")
  })
})
