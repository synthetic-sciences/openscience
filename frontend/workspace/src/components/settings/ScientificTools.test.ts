import { describe, expect, test } from "bun:test"
import {
  capabilityState,
  filterScientificCapabilities,
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
  current_availability: { local: "setup_needed" },
  basis: "Packaged scientific runtime.",
  source: { kind: "pypi", name: "scipy", version: "1.18.1", reference: "https://pypi.org/project/scipy/1.18.1/" },
  runtime: {
    pack_id: "core-science-py312-v1",
    python: "3.12.11",
    image: "image@sha256:x",
    lock_digest: "x",
    packages: ["scipy==1.18.1"],
  },
  ...overrides,
})

describe("scientific tools settings state", () => {
  test("filters the local tool catalog", () => {
    const records = [
      item(),
      item({
        id: "boltz2",
        name: "Boltz-2",
        runtime: undefined,
      }),
      item({
        id: "alphafold2",
        name: "AlphaFold2",
        runtime: undefined,
        maturity: "blocked",
        current_availability: { local: "unavailable" },
      }),
    ]
    expect(filterScientificCapabilities(records, "", "packaged").map((value) => value.id)).toEqual(["scipy"])
    expect(filterScientificCapabilities(records, "", "blocked").map((value) => value.id)).toEqual(["alphafold2"])
    expect(filterScientificCapabilities(records, "", "setup").map((value) => value.id)).toEqual(["scipy", "boltz2"])
    expect(filterScientificCapabilities(records, "boltz", "all").map((value) => value.id)).toEqual(["boltz2"])
  })

  test("summarizes local availability in user-facing states", () => {
    expect(capabilityState(item())).toMatchObject({ label: "Available" })
    expect(capabilityState(item({ maturity: "blocked" }))).toMatchObject({ label: "Unavailable" })
    expect(capabilityState(item({ current_availability: { local: "ready" } }))).toMatchObject({
      label: "Ready",
    })
    expect(capabilityState(item({ current_availability: { local: "degraded" } }))).toMatchObject({
      label: "Needs attention",
    })
  })
})
