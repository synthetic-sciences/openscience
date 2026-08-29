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
  availability: { local: "setup_needed", hosted: "setup_needed" },
  current_availability: { local: "setup_needed", hosted: "setup_needed" },
  basis: "Bounded packaged runtime, not yet release-verified.",
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
  test("filters by execution truth rather than marketing categories", () => {
    const records = [
      item(),
      item({
        id: "boltz2",
        name: "Boltz-2",
        runtime: undefined,
        hosted: {
          kind: "nvidia_nim",
          adapter_id: "boltz2",
          docs_url: "https://example.com",
          terms_url: "https://example.com",
        },
      }),
      item({
        id: "alphafold2",
        name: "AlphaFold2",
        runtime: undefined,
        maturity: "blocked",
        availability: { local: "unavailable", hosted: "unavailable" },
      }),
    ]
    expect(filterScientificCapabilities(records, "", "packaged").map((value) => value.id)).toEqual(["scipy"])
    expect(filterScientificCapabilities(records, "", "hosted").map((value) => value.id)).toEqual(["boltz2"])
    expect(filterScientificCapabilities(records, "", "blocked").map((value) => value.id)).toEqual(["alphafold2"])
    expect(filterScientificCapabilities(records, "boltz", "all").map((value) => value.id)).toEqual(["boltz2"])
  })

  test("records evidence without promoting manifest maturity", () => {
    expect(capabilityState(item(), [])).toEqual({ label: "Packaged · experimental", tone: "warning" })
    expect(
      capabilityState(item(), [
        {
          capability: {
            id: "scipy",
            version: "2",
            manifest_sha256: "x",
            profile: "smoke",
            runtime_digest: "y",
          },
          target: "modal",
          job_id: "job",
          app_version: "2",
          verified_at: "2026-08-28T00:00:00Z",
          metrics: {},
          artifacts: [],
        },
      ]),
    ).toEqual({ label: "Smoke recorded · experimental", tone: "warning" })
    expect(capabilityState(item({ maturity: "verified" }), [])).toEqual({
      label: "Release verified",
      tone: "success",
    })
    expect(capabilityState(item({ maturity: "blocked" }), [])).toEqual({ label: "Blocked", tone: "danger" })
    expect(capabilityState(item({ current_availability: { local: "ready", hosted: "setup_needed" } }), [])).toEqual({
      label: "Ready locally · experimental",
      tone: "warning",
    })
    expect(
      capabilityState(item({ current_availability: { local: "not_applicable", hosted: "configured" } }), []),
    ).toEqual({
      label: "Credential configured · not live-tested",
      tone: "warning",
    })
  })
})
